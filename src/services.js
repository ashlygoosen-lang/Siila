const crypto = require('crypto');
const os = require('os');
const path = require('path');
const db = require('./db');
const { sendMail } = require('./mailer');
const { emit } = require('./events');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'siira.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || (dbPath === ':memory:' ? path.join(os.tmpdir(), 'talentbridge-uploads') : path.join(path.dirname(dbPath), 'uploads'));
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const baseUrl = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
const company = () => ({ name: process.env.COMPANY_NAME || '', reg: process.env.COMPANY_REG || '', vat: process.env.VAT_NUMBER || '', address: process.env.COMPANY_ADDRESS || '', email: process.env.SUPPORT_EMAIL || '', phone: process.env.SUPPORT_PHONE || '', info_officer: process.env.INFO_OFFICER || '' });

function createToken(uid, kind, minutes) {
  const raw = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO tokens (user_id,kind,token_hash,expires_at) VALUES (?,?,?,datetime('now', ?))").run(uid, kind, sha(raw), `+${minutes} minutes`);
  return raw;
}
function consumeToken(kind, raw) {
  const r = db.prepare("SELECT * FROM tokens WHERE kind = ? AND token_hash = ? AND used = 0 AND expires_at > datetime('now')").get(kind, sha(String(raw || '')));
  if (!r) return null;
  db.prepare('UPDATE tokens SET used = 1 WHERE id = ?').run(r.id);
  return r.user_id;
}

const setting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? Number(r.value) : d; };
// In-app notification (live-pushed to open dashboards) plus an email for important events.
function notify(uid, type, text, link = '', actorId = null) {
  const id = db.prepare('INSERT INTO notifications (user_id,type,text,link,actor_id) VALUES (?,?,?,?,?)').run(uid, type, text, link, actorId).lastInsertRowid;
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  emit(uid, 'notification', row);
  emit(uid, 'counts', counts(uid));
  if (type === 'message') return row; // chat messages are in-app only
  const u = db.prepare('SELECT email, status FROM users WHERE id = ?').get(uid);
  if (u && u.status === 'active') sendMail(u.email, 'TalentBridge update', `${text}\n\nOpen your dashboard: ${process.env.APP_URL || ''}/app.html${link || ''}`);
  return row;
}

// Unread counters shown in the dashboard sidebar.
function counts(uid) {
  uid = Number(uid);
  return {
    notifications: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0').get(uid).n,
    inbox: db.prepare(`SELECT COUNT(*) n FROM chat_messages m JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = ?
      WHERE (c.client_id = ? OR c.talent_id = ?) AND m.sender_id != ? AND m.id > IFNULL(r.last_read_id, 0)`).get(uid, uid, uid, uid).n,
  };
}

// ---- inbox ----
function getOrCreateConversation(clientId, talentId, jobId = null) {
  const found = db.prepare('SELECT * FROM conversations WHERE client_id = ? AND talent_id = ? AND IFNULL(job_id,0) = ?').get(clientId, talentId, jobId || 0);
  if (found) return found;
  const id = db.prepare('INSERT INTO conversations (job_id, client_id, talent_id) VALUES (?,?,?)').run(jobId || null, clientId, talentId).lastInsertRowid;
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

const MESSAGE_SELECT = `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.kind, m.attachment_name, m.attachment_mime, m.attachment_size,
  m.created_at, u.name AS sender_name FROM chat_messages m JOIN users u ON u.id = m.sender_id`;

// Adds a message (or a system "event" line such as "Offer accepted") and pushes it live to both parties.
function postMessage(conv, senderId, body, kind = 'text', attachment = null) {
  const id = db.prepare(`INSERT INTO chat_messages (conversation_id, sender_id, body, kind, attachment_path, attachment_name, attachment_mime, attachment_size)
    VALUES (?,?,?,?,?,?,?,?)`).run(conv.id, senderId, body, kind, attachment?.path || '', attachment?.name || '', attachment?.mime || '', attachment?.size || 0).lastInsertRowid;
  db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(conv.id);
  db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_id) VALUES (?,?,?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_id = excluded.last_read_id`).run(conv.id, senderId, id);
  const message = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
  for (const uid of [conv.client_id, conv.talent_id]) {
    emit(uid, 'message', message);
    emit(uid, 'counts', counts(uid));
  }
  if (kind === 'text') {
    const other = senderId === conv.client_id ? conv.talent_id : conv.client_id;
    const sender = db.prepare('SELECT name FROM users WHERE id = ?').get(senderId)?.name || 'Someone';
    const preview = body ? `: "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"` : ' sent you a file';
    notify(other, 'message', `${sender}${preview}`, `#inbox/${conv.id}`, senderId);
  }
  return message;
}
const audit = (actor, action, target = '', meta = {}) =>
  db.prepare('INSERT INTO audit_log (actor_id,action,target,meta) VALUES (?,?,?,?)').run(actor, action, String(target), JSON.stringify(meta));

// Fees are taken from the professional's payout: commission (excl. VAT) + VAT on that commission.
function calcFees(amountCents) {
  const commission = Math.round(amountCents * setting('commission_pct', 10) / 100);
  const vat = Math.round(commission * setting('vat_pct', 15) / 100);
  return { commission_cents: commission, vat_cents: vat, payout_cents: amountCents - commission - vat };
}

// sandbox: simulate payments (dev) | manual: EFT, admin confirms | paystack: card/EFT via Paystack
const paymentsMode = () => process.env.PAYMENTS_MODE || (process.env.NODE_ENV === 'production' ? 'manual' : 'sandbox');

function markFunded(contractId, reference) {
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  if (!c || c.status !== 'accepted') return false;
  db.transaction(() => {
    db.prepare("UPDATE payments SET status = 'paid' WHERE contract_id = ? AND reference = ?").run(contractId, reference);
    db.prepare("UPDATE contracts SET status = 'funded', updated_at = datetime('now') WHERE id = ?").run(contractId);
  })();
  const link = `#contracts/${c.id}`;
  notify(c.talent_id, 'funded', `Contract #${c.id} is funded. Funds are in escrow, so you can start work.`, link, c.client_id);
  notify(c.client_id, 'funded', `Payment received for contract #${c.id}. Funds are held safely until you approve the work.`, link);
  contractEvent(c, 'Escrow funded. Work can start.');
  return true;
}

// Posts a system line ("Offer accepted", "Work delivered"...) into the pair's inbox thread.
function contractEvent(c, text, actorId = null) {
  const conv = getOrCreateConversation(c.client_id, c.talent_id, c.job_id);
  return postMessage(conv, actorId || c.client_id, `${text}|contract:${c.id}`, 'event');
}

module.exports = { UPLOAD_DIR, baseUrl, company, createToken, consumeToken, setting, notify, counts, getOrCreateConversation, postMessage, contractEvent, MESSAGE_SELECT, audit, calcFees, paymentsMode, markFunded };
