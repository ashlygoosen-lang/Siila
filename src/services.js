const db = require('./db');

const setting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? Number(r.value) : d; };
const notify = (uid, type, text) => db.prepare('INSERT INTO notifications (user_id,type,text) VALUES (?,?,?)').run(uid, type, text);
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

module.exports = { setting, notify, audit, calcFees, paymentsMode, markFunded };
