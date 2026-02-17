const { scopeSQL } = require('../auth/clientScope');

class TicketService {
  constructor(db) {
    this.db = db;
  }

  getAll(status) {
    if (status) {
      return this.db.prepare('SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC').all(status);
    }
    return this.db.prepare('SELECT * FROM tickets ORDER BY created_at DESC').all();
  }

  getById(id) {
    const ticket = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (ticket) {
      ticket.comments = this.db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(id);
    }
    return ticket;
  }

  create(data) {
    const result = this.db.prepare(
      'INSERT INTO tickets (device_id, title, description, priority, category, ai_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))'
    ).run(data.deviceId, data.title, data.description || '', data.priority || 'medium', data.category || '', data.aiSummary || '');
    return { id: result.lastInsertRowid, ...data };
  }

  update(id, data) {
    const fields = [];
    const values = [];
    if (data.status) { fields.push('status = ?'); values.push(data.status); }
    if (data.priority) { fields.push('priority = ?'); values.push(data.priority); }
    if (data.assigned_to !== undefined) { fields.push('assigned_to = ?'); values.push(data.assigned_to); }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  }

  addComment(ticketId, author, content) {
    this.db.prepare(
      'INSERT INTO ticket_comments (ticket_id, author, content) VALUES (?, ?, ?)'
    ).run(ticketId, author, content);
  }

  getOpenCount(scope) {
    const { clause, params } = scopeSQL(scope, 'd');
    if (!scope || scope.isAdmin || scope.clientIds === null) {
      return this.db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status IN ('open', 'in_progress')").get().count;
    }
    return this.db.prepare(`SELECT COUNT(*) as count FROM tickets t JOIN devices d ON t.device_id = d.device_id WHERE t.status IN ('open', 'in_progress') AND ${clause}`).get(...params).count;
  }

  getTotalCount(scope) {
    const { clause, params } = scopeSQL(scope, 'd');
    if (!scope || scope.isAdmin || scope.clientIds === null) {
      return this.db.prepare('SELECT COUNT(*) as count FROM tickets').get().count;
    }
    return this.db.prepare(`SELECT COUNT(*) as count FROM tickets t JOIN devices d ON t.device_id = d.device_id WHERE ${clause}`).get(...params).count;
  }
}

module.exports = TicketService;
