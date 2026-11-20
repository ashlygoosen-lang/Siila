const crypto = require('crypto');
const os = require('os');
const path = require('path');
const db = require('./db');
const { sendMail } = require('./mailer');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'siira.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || (dbPath === ':memory:' ? path.join(os.tmpdir(), 'siira-uploads') : path.join(path.dirname(dbPath), 'uploads'));
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
function notify(uid, type, text) {
  db.prepare('INSERT INTO notifications (user_id,type,text) VALUES (?,?,?)').run(uid, type, text);
  if (type === 'message') return; // chat messages are in-app only
  const u = db.prepare('SELECT email, status FROM users WHERE id = ?').get(uid);
  if (u && u.status === 'active') sendMail(u.email, 'SIIRA update', `${text}\n\nOpen your dashboard: ${process.env.APP_URL || ''}/app.html`);
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
  notify(c.talent_id, 'contract', `Contract #${c.id} is funded. You can start work.`);
  notify(c.client_id, 'contract', `Payment received for contract #${c.id}. Funds are held safely until you approve the work.`);
  return true;
}

module.exports = { UPLOAD_DIR, baseUrl, company, createToken, consumeToken, setting, notify, audit, calcFees, paymentsMode, markFunded };
