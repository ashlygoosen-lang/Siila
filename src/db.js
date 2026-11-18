require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'siira.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('talent','client','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  hourly_rate INTEGER,
  province TEXT DEFAULT '',
  city TEXT DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  jobs_done INTEGER NOT NULL DEFAULT 0,
  avatar_color TEXT NOT NULL DEFAULT '#0a3d8f'
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Full-Time','Part-Time','Freelance','Short-Term')),
  province TEXT NOT NULL,
  city TEXT NOT NULL,
  pay_min INTEGER NOT NULL,
  pay_max INTEGER NOT NULL,
  pay_unit TEXT NOT NULL CHECK (pay_unit IN ('hour','day','month','project')),
  icon TEXT NOT NULL DEFAULT 'brief',
  gradient TEXT NOT NULL DEFAULT 'linear-gradient(135deg,#06183d,#0a3d8f)',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_filter ON jobs(status, type, category, province);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','shortlisted','rejected','hired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, user_id)
);
CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, job_id)
);
CREATE TABLE IF NOT EXISTS hire_requests (
  id INTEGER PRIMARY KEY,
  talent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const addCol = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
addCol('users', 'phone', "TEXT DEFAULT ''");
addCol('users', 'consent_at', 'TEXT');
addCol('jobs', 'featured', 'INTEGER NOT NULL DEFAULT 0');
addCol('jobs', 'moderation_note', "TEXT DEFAULT ''");
addCol('hire_requests', 'status', "TEXT NOT NULL DEFAULT 'new'");
addCol('hire_requests', 'admin_note', "TEXT DEFAULT ''");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('commission_pct','10'),('vat_pct','15');
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_type TEXT NOT NULL, ref_last4 TEXT NOT NULL DEFAULT '', note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', review_note TEXT DEFAULT '', reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), client_id INTEGER NOT NULL REFERENCES users(id),
  talent_id INTEGER NOT NULL REFERENCES users(id), description TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL, commission_cents INTEGER NOT NULL, vat_cents INTEGER NOT NULL, payout_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered', delivery_note TEXT DEFAULT '', payout_ref TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id), provider TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE, amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL UNIQUE REFERENCES contracts(id), reviewer_id INTEGER NOT NULL,
  talent_id INTEGER NOT NULL, rating INTEGER NOT NULL, comment TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id), sender_id INTEGER NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL,
  text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY, reporter_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', admin_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, target TEXT DEFAULT '', meta TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

module.exports = db;
