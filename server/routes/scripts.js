const express = require('express');
const router = express.Router();

module.exports = function createScriptsRouter() {
  router.get('/', (req, res) => {
    try {
      const { category } = req.query;
      let scripts;
      if (category) {
        scripts = req.app.locals.db.prepare('SELECT * FROM script_library WHERE category = ? ORDER BY name').all(category);
      } else {
        scripts = req.app.locals.db.prepare('SELECT * FROM script_library ORDER BY category, name').all();
      }
      res.json(scripts);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const script = req.app.locals.db.prepare('SELECT * FROM script_library WHERE id = ?').get(req.params.id);
      if (!script) return res.status(404).json({ error: 'Script not found' });
      res.json(script);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    const { name, description, script_content, category, requires_elevation, timeout_seconds, ai_tool, os_type = 'windows' } = req.body;
    if (!name || !script_content) {
      return res.status(400).json({ error: 'Missing required fields: name, script_content' });
    }
    try {
      const result = req.app.locals.db.prepare(
        'INSERT INTO script_library (name, description, script_content, category, requires_elevation, timeout_seconds, ai_tool, os_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(name, description || null, script_content, category || 'general', requires_elevation || 0, timeout_seconds || 60, ai_tool || 0, os_type);
      const script = req.app.locals.db.prepare('SELECT * FROM script_library WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(script);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id', (req, res) => {
    const { id } = req.params;
    const allowed = ['name', 'description', 'script_content', 'category', 'requires_elevation', 'timeout_seconds', 'ai_tool', 'os_type'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    values.push(id);
    try {
      req.app.locals.db.prepare(`UPDATE script_library SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const script = req.app.locals.db.prepare('SELECT * FROM script_library WHERE id = ?').get(id);
      res.json(script);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      req.app.locals.db.prepare('DELETE FROM script_library WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
