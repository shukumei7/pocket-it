#!/usr/bin/env node
const path = require('path');
const { initDatabase } = require('./db/schema');
const { hashPassword } = require('./auth/userAuth');

async function main() {
  const args = process.argv.slice(2);
  const usernameIdx = args.indexOf('--username');
  const passwordIdx = args.indexOf('--password');

  if (usernameIdx === -1 || passwordIdx === -1 || !args[usernameIdx + 1] || !args[passwordIdx + 1]) {
    console.error('Usage: node seed-admin.js --username <username> --password <password>');
    process.exit(1);
  }

  const username = args[usernameIdx + 1];
  const password = args[passwordIdx + 1];

  if (password.length < 8) {
    console.error('Error: Password must be at least 8 characters');
    process.exit(1);
  }

  const dbPath = path.join(process.env.POCKET_IT_DATA_DIR || path.join(__dirname, 'db'), 'pocket-it.db');
  const db = initDatabase(dbPath);

  // Check if user exists
  const existing = db.prepare('SELECT id FROM it_users WHERE username = ?').get(username);
  if (existing) {
    console.error(`Error: User '${username}' already exists`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const createdAt = new Date().toISOString();

  db.prepare(
    'INSERT INTO it_users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(username, passwordHash, username, 'superadmin', createdAt);

  console.log(`Superadmin user '${username}' created successfully`);
  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
