require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// On Railway, keep the database (and uploads, backups and keys beside it) on the attached volume so they survive deploys.
if (!process.env.DB_PATH && process.env.RAILWAY_VOLUME_MOUNT_PATH) process.env.DB_PATH = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'talentbridge.db');
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
addCol('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addCol('jobs', 'featured', 'INTEGER NOT NULL DEFAULT 0');
addCol('jobs', 'moderation_note', "TEXT DEFAULT ''");
addCol('hire_requests', 'status', "TEXT NOT NULL DEFAULT 'new'");
addCol('hire_requests', 'admin_note', "TEXT DEFAULT ''");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('commission_pct','10'),('vat_pct','15');
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_tokens ON tokens(kind, token_hash);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT (datetime('now')));
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

addCol('verifications', 'doc_path', "TEXT DEFAULT ''");
addCol('verifications', 'doc_mime', "TEXT DEFAULT ''");

// ---- TalentBridge: bids, inbox, live feed, milestones, portfolio ----
addCol('applications', 'bid_amount', 'INTEGER');
addCol('applications', 'delivery_days', 'INTEGER');
addCol('applications', 'updated_at', 'TEXT');
addCol('notifications', 'link', "TEXT DEFAULT ''");
addCol('notifications', 'actor_id', 'INTEGER');
addCol('profiles', 'portfolio', "TEXT NOT NULL DEFAULT '[]'");
addCol('profiles', 'languages', "TEXT DEFAULT ''");
addCol('users', 'last_seen_at', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  talent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_pair ON conversations(client_id, talent_id, IFNULL(job_id, 0));
CREATE INDEX IF NOT EXISTS idx_conv_client ON conversations(client_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_conv_talent ON conversations(talent_id, last_message_at);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  attachment_path TEXT DEFAULT '',
  attachment_name TEXT DEFAULT '',
  attachment_mime TEXT DEFAULT '',
  attachment_size INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS contract_milestones (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','approved')),
  note TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_milestones ON contract_milestones(contract_id, position);
`);

// One-time: move older contract messages into the new inbox conversations.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'inbox_migrated'").get()) {
  db.transaction(() => {
    const rows = db.prepare('SELECT m.*, c.job_id, c.client_id, c.talent_id FROM messages m JOIN contracts c ON c.id = m.contract_id ORDER BY m.id').all();
    const conv = db.prepare('SELECT id FROM conversations WHERE client_id = ? AND talent_id = ? AND IFNULL(job_id,0) = ?');
    const addConv = db.prepare('INSERT INTO conversations (job_id, client_id, talent_id, created_at, last_message_at) VALUES (?,?,?,?,?)');
    const addMsg = db.prepare('INSERT INTO chat_messages (conversation_id, sender_id, body, created_at) VALUES (?,?,?,?)');
    const touch = db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?');
    for (const m of rows) {
      const id = conv.get(m.client_id, m.talent_id, m.job_id || 0)?.id ?? addConv.run(m.job_id, m.client_id, m.talent_id, m.created_at, m.created_at).lastInsertRowid;
      addMsg.run(id, m.sender_id, m.body, m.created_at);
      touch.run(m.created_at, id);
    }
    db.prepare("INSERT INTO settings VALUES ('inbox_migrated','1')").run();
    db.prepare("UPDATE users SET name = 'TalentBridge Admin' WHERE name = 'SIIRA Admin'").run();
  })();
}

// ---- Identity verification (KYC), qualifications, bank details and fraud/AML controls ----
addCol('users', 'kyc_status', "TEXT NOT NULL DEFAULT 'none'"); // none | draft | pending | needs_info | approved | rejected
addCol('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
addCol('users', 'locked_until', 'TEXT');
addCol('contracts', 'aml_hold', 'INTEGER NOT NULL DEFAULT 0');
addCol('payments', 'provider_ref', "TEXT NOT NULL DEFAULT ''");
addCol('payments', 'paid_at', 'TEXT');
// Allow work permit and SAQA certificate uploads in databases created before these kinds existed (SQLite can't alter a CHECK, so rebuild).
if (!/work_permit/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kyc_documents'").get()?.sql || 'work_permit')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kyc_documents'").get().sql.replace("'qualification'))", "'qualification','work_permit','saqa'))").replace(/CREATE TABLE (IF NOT EXISTS )?"?kyc_documents"?/, 'CREATE TABLE kyc_documents_new');
    db.exec(sql);
    db.exec('INSERT INTO kyc_documents_new SELECT * FROM kyc_documents; DROP TABLE kyc_documents; ALTER TABLE kyc_documents_new RENAME TO kyc_documents;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_kyc_docs_user ON kyc_documents(user_id, kind); CREATE INDEX IF NOT EXISTS idx_kyc_docs_sha ON kyc_documents(sha256);');
  })();
  db.pragma('foreign_keys = ON');
}
// International talent and work-visa sponsorship
for (const [c, d] of [['contract_term', "TEXT NOT NULL DEFAULT ''"], ['duration_months', 'INTEGER'], ['occupation_ofo', "TEXT NOT NULL DEFAULT ''"], ['remote', 'INTEGER NOT NULL DEFAULT 0'],
  ['intl_status', "TEXT NOT NULL DEFAULT 'none'"], ['intl_requested_at', 'TEXT'], ['intl_decided_at', 'TEXT'], ['intl_decider_id', 'INTEGER'], ['intl_note', "TEXT NOT NULL DEFAULT ''"],
  ['local_applicants', 'INTEGER'], ['local_reason', "TEXT NOT NULL DEFAULT ''"], ['salary_annual', 'INTEGER']]) addCol('jobs', c, d);
for (const [c, d] of [['residency', "TEXT NOT NULL DEFAULT ''"], ['work_rights', "TEXT NOT NULL DEFAULT ''"], ['country', "TEXT NOT NULL DEFAULT ''"], ['nationality', "TEXT NOT NULL DEFAULT ''"],
  ['relocate', 'INTEGER NOT NULL DEFAULT 0'], ['occupation_ofo', "TEXT NOT NULL DEFAULT ''"], ['experience_years', 'INTEGER'], ['saqa_status', "TEXT NOT NULL DEFAULT ''"],
  ['prof_body', "TEXT NOT NULL DEFAULT ''"], ['prof_reg_no', "TEXT NOT NULL DEFAULT ''"]]) addCol('profiles', c, d);
db.exec(`CREATE TABLE IF NOT EXISTS sponsorships (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  client_id INTEGER NOT NULL REFERENCES users(id),
  talent_id INTEGER NOT NULL REFERENCES users(id),
  route TEXT NOT NULL CHECK (route IN ('critical_skills','general_work')),
  occupation_ofo TEXT NOT NULL DEFAULT '',
  salary_annual INTEGER NOT NULL,
  start_date TEXT,
  terms TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','withdrawn','documents','submitted','approved','refused','arrived','closed')),
  use_agent INTEGER NOT NULL DEFAULT 1,
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_spons_parties ON sponsorships(client_id, talent_id);
CREATE TABLE IF NOT EXISTS sponsorship_events (
  id INTEGER PRIMARY KEY,
  sponsorship_id INTEGER NOT NULL REFERENCES sponsorships(id) ON DELETE CASCADE,
  actor_id INTEGER,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

db.exec(`
CREATE TABLE IF NOT EXISTS kyc_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL DEFAULT 'individual' CHECK (account_type IN ('individual','business')),
  legal_name TEXT NOT NULL DEFAULT '',
  id_type TEXT NOT NULL DEFAULT 'sa_id' CHECK (id_type IN ('sa_id','passport')),
  id_number_enc TEXT NOT NULL DEFAULT '',
  id_number_hash TEXT NOT NULL DEFAULT '',
  id_last4 TEXT NOT NULL DEFAULT '',
  id_country TEXT NOT NULL DEFAULT 'South Africa',
  dob TEXT NOT NULL DEFAULT '',
  nationality TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address_line TEXT NOT NULL DEFAULT '',
  suburb TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  province TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  is_pep INTEGER NOT NULL DEFAULT 0,
  pep_details TEXT NOT NULL DEFAULT '',
  source_of_funds TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL DEFAULT '',
  business_reg TEXT NOT NULL DEFAULT '',
  business_role TEXT NOT NULL DEFAULT '',
  consent_at TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  reviewer_id INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kyc_idhash ON kyc_profiles(id_number_hash);
CREATE TABLE IF NOT EXISTS kyc_documents (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('id_front','id_back','proof_of_address','selfie','company_reg','cv','qualification','work_permit','saqa')),
  qualification_id INTEGER,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','replaced')),
  note TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewer_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_user ON kyc_documents(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_sha ON kyc_documents(sha256);
CREATE TABLE IF NOT EXISTS qualifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution TEXT NOT NULL,
  qualification TEXT NOT NULL,
  field TEXT NOT NULL DEFAULT '',
  year INTEGER,
  student_number TEXT NOT NULL DEFAULT '',
  certificate_number TEXT NOT NULL DEFAULT '',
  institution_contact TEXT NOT NULL DEFAULT '',
  consent_to_contact INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','verified','rejected','unverifiable')),
  verify_method TEXT NOT NULL DEFAULT '',
  verify_contact TEXT NOT NULL DEFAULT '',
  verify_reference TEXT NOT NULL DEFAULT '',
  verify_note TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  verifier_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  bank TEXT NOT NULL,
  account_enc TEXT NOT NULL,
  account_hash TEXT NOT NULL,
  account_last4 TEXT NOT NULL,
  branch_code TEXT NOT NULL DEFAULT '',
  account_type TEXT NOT NULL DEFAULT 'cheque',
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_hash ON bank_accounts(account_hash);
CREATE TABLE IF NOT EXISTS risk_flags (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  contract_id INTEGER,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','confirmed')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolver_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flags_user ON risk_flags(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flags_unique ON risk_flags(IFNULL(user_id,0), IFNULL(contract_id,0), kind, detail);
`);

// Remote work: escrow-first remote jobs, international companies, partner job feeds, cached lookups.
for (const [c, d] of [['escrow_required', 'INTEGER NOT NULL DEFAULT 0'], ['escrow_cents', 'INTEGER NOT NULL DEFAULT 0'], ['escrow_balance_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['escrow_refund_cents', 'INTEGER NOT NULL DEFAULT 0'], ['funded_at', 'TEXT'], ['company_country', "TEXT NOT NULL DEFAULT ''"]]) addCol('jobs', c, d);
for (const [c, d] of [['country', "TEXT NOT NULL DEFAULT ''"], ['currency', "TEXT NOT NULL DEFAULT 'ZAR'"], ['company', "TEXT NOT NULL DEFAULT ''"]]) addCol('users', c, d);
// Remote jobs wait in 'awaiting_funding' until their escrow is paid. SQLite can't alter a CHECK, so rebuild the table once.
if (!/awaiting_funding/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'jobs'").get().sql)) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'jobs'").get().sql;
    const next = sql.replace(/status IN \('open',\s*'closed'\)/, "status IN ('open','closed','awaiting_funding')").replace(/CREATE TABLE (IF NOT EXISTS )?"?jobs"?/, 'CREATE TABLE jobs_new');
    if (next === sql || !/awaiting_funding/.test(next)) throw new Error('jobs table migration: status check not found');
    db.exec(next);
    const cols = db.prepare('PRAGMA table_info(jobs)').all().map(c => `"${c.name}"`).join(',');
    db.exec(`INSERT INTO jobs_new (${cols}) SELECT ${cols} FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_new RENAME TO jobs;`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_filter ON jobs(status, type, category, province);');
  })();
  db.pragma('foreign_keys = ON');
}
// When each money step happened, so every party sees dates, not just a status.
for (const c of ['funded_at', 'delivered_at', 'released_at', 'paid_out_at', 'disputed_at', 'refunded_at']) addCol('contracts', c, 'TEXT');
addCol('contracts', 'refund_ref', "TEXT NOT NULL DEFAULT ''");
addCol('contracts', 'resolution', "TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS job_deposits (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','void','cancelled')),
  provider_ref TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deposits_job ON job_deposits(job_id, status);
CREATE TABLE IF NOT EXISTS escrow_refunds (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  client_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','refunded')),
  reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  refunded_at TEXT
);
CREATE TABLE IF NOT EXISTS feed_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  job_type TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  open_to_sa INTEGER NOT NULL DEFAULT 0,
  salary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feed_pub ON feed_jobs(published_at);
CREATE TABLE IF NOT EXISTS cache_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

module.exports = db;
