// Escrow-first remote jobs. A remote job stays hidden ("awaiting_funding") until the client has paid the budget
// into escrow. Hiring then draws each contract from that balance, and whatever is left can be refunded.
const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./util');
const { notify, paymentsMode, markFunded, audit, baseUrl } = require('./services');

// The least a client must hold in escrow before a remote job goes live: one full pay period at the top of the range.
const PERIODS = { project: 1, month: 1, day: 5, hour: 40 };
const PERIOD_LABEL = { project: 'the whole project', month: 'one month', day: 'five days', hour: 'one 40-hour week' };
const minEscrowCents = (j) => Math.max(50, Number(j.pay_max || 0)) * (PERIODS[j.pay_unit] || 1) * 100;

const reserved = (jobId) => db.prepare(`SELECT IFNULL(SUM(amount_cents),0) n FROM contracts WHERE job_id = ? AND status IN ('offered','accepted')`).get(jobId).n;

/** What the job owner (and admin) sees about the job's escrow. */
function summary(j) {
  if (!j.escrow_required) return null;
  const pending = db.prepare("SELECT reference, provider, amount_cents, created_at FROM job_deposits WHERE job_id = ? AND status = 'pending' ORDER BY id DESC").get(j.id) || null;
  const paid = db.prepare("SELECT IFNULL(SUM(amount_cents),0) n FROM job_deposits WHERE job_id = ? AND status = 'paid'").get(j.id).n;
  const refunds = db.prepare('SELECT amount_cents, status, created_at, refunded_at FROM escrow_refunds WHERE job_id = ? ORDER BY id DESC').all(j.id);
  return {
    required_cents: j.escrow_cents, minimum_cents: minEscrowCents(j), minimum_label: PERIOD_LABEL[j.pay_unit] || 'one pay period',
    balance_cents: j.escrow_balance_cents, paid_cents: paid, reserved_cents: reserved(j.id), funded: !!j.funded_at, funded_at: j.funded_at,
    due_cents: j.funded_at ? 0 : Math.max(0, j.escrow_cents - j.escrow_balance_cents), pending, refunds,
  };
}

/** Start a payment into a job's escrow. Returns what the browser needs for the current payment mode. */
function startDeposit(req, j, amountCents) {
  if (!j.escrow_required) throw new HttpError(409, 'This job doesn’t use upfront escrow');
  if (['closed'].includes(j.status)) throw new HttpError(409, 'Reopen the job before adding money to its escrow');
  if (!Number.isInteger(amountCents) || amountCents < 5000) throw new HttpError(400, 'Enter an amount of at least R50');
  if (amountCents > 100000000) throw new HttpError(400, 'For amounts above R1,000,000 please contact us');
  const mode = paymentsMode();
  const reference = `TBJ-${j.id}-${crypto.randomBytes(4).toString('hex')}`;
  db.prepare("UPDATE job_deposits SET status = 'void' WHERE job_id = ? AND status = 'pending'").run(j.id);
  db.prepare('INSERT INTO job_deposits (job_id, client_id, provider, reference, amount_cents) VALUES (?,?,?,?,?)').run(j.id, j.client_id, mode, reference, amountCents);
  audit(req.user.id, 'escrow.deposit_started', j.id, { reference, amount_cents: amountCents, mode });
  if (mode === 'payfast') {
    const PF = require('./payfast');
    if (!PF.configured()) throw new HttpError(503, 'Card payments are not set up yet. Please contact support.');
    const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id);
    const [first, ...rest] = String(u.name || '').trim().split(/\s+/);
    const out = PF.checkout({ reference, amountCents, itemName: `TalentBridge escrow for job #${j.id}`, itemDescription: `Upfront escrow: ${j.title}`,
      buyer: { first, last: rest.join(' '), email: u.email }, contractId: 0, returnHash: `job/${j.id}`, baseUrl: baseUrl(req) });
    return { mode, reference, amount_cents: amountCents, ...out };
  }
  if (mode === 'manual') return { mode, reference, amount_cents: amountCents, instructions: `Pay R${(amountCents / 100).toLocaleString('en-ZA')} by EFT using reference ${reference}. Your job goes live as soon as TalentBridge confirms the payment, usually within one business day.` };
  if (mode === 'paystack') throw new HttpError(503, 'Upfront escrow uses PayFast or EFT. Please contact support.');
  return { mode, reference, amount_cents: amountCents, instructions: 'Sandbox mode: confirm the test payment to continue.' };
}

/** A deposit was paid (PayFast ITN, admin EFT confirmation or sandbox). Idempotent. Returns the job, or null. */
function markDepositPaid(reference, providerRef = '') {
  const d = db.prepare('SELECT * FROM job_deposits WHERE reference = ?').get(reference);
  if (!d || d.status === 'paid') return null;
  let opened = false;
  const j = db.transaction(() => {
    db.prepare("UPDATE job_deposits SET status = 'paid', paid_at = datetime('now'), provider_ref = ? WHERE id = ?").run(String(providerRef || ''), d.id);
    db.prepare('UPDATE jobs SET escrow_balance_cents = escrow_balance_cents + ? WHERE id = ?').run(d.amount_cents, d.job_id);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(d.job_id);
    if (job.status === 'awaiting_funding' && job.escrow_balance_cents >= job.escrow_cents) {
      db.prepare("UPDATE jobs SET status = 'open', funded_at = datetime('now'), created_at = datetime('now') WHERE id = ?").run(job.id);
      opened = true;
    }
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(d.job_id);
  })();
  const R = (c) => 'R' + (c / 100).toLocaleString('en-ZA');
  audit(null, 'escrow.deposit_paid', j.id, { reference, amount_cents: d.amount_cents });
  if (opened) {
    notify(j.client_id, 'funded', `Escrow received (${R(d.amount_cents)}). "${j.title}" is now live and matching professionals have been alerted.`, `#job/${j.id}`);
    require('./jobalerts').announceJob(j, j.client_id);
  } else {
    notify(j.client_id, 'funded', `${R(d.amount_cents)} added to the escrow for "${j.title}". Balance: ${R(j.escrow_balance_cents)}.`, `#job/${j.id}`);
  }
  return j;
}

/** Pay a contract on an escrow-first job straight from the job's balance. */
function fundContractFromJob(c) {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(c.job_id);
  if (!j?.escrow_required) return false;
  if (j.escrow_balance_cents < c.amount_cents) {
    const short = c.amount_cents - j.escrow_balance_cents;
    throw new HttpError(409, `This job has R${(j.escrow_balance_cents / 100).toLocaleString('en-ZA')} in escrow but the contract is R${(c.amount_cents / 100).toLocaleString('en-ZA')}. Add R${(short / 100).toLocaleString('en-ZA')} to the job’s escrow first.`, [{ field: 'top_up_cents', message: String(short) }]);
  }
  const reference = `TBE-${c.id}-${crypto.randomBytes(4).toString('hex')}`;
  db.transaction(() => {
    db.prepare("UPDATE payments SET status = 'void' WHERE contract_id = ? AND status = 'pending'").run(c.id);
    db.prepare("INSERT INTO payments (contract_id, provider, reference, amount_cents) VALUES (?, 'job_escrow', ?, ?)").run(c.id, reference, c.amount_cents);
    db.prepare('UPDATE jobs SET escrow_balance_cents = escrow_balance_cents - ? WHERE id = ? AND escrow_balance_cents >= ?').run(c.amount_cents, j.id, c.amount_cents);
  })();
  markFunded(c.id, reference);
  return true;
}

/** Client asks for the unused escrow back. The job closes; TalentBridge refunds to the original payment method. */
function requestRefund(userId, j) {
  if (!j.escrow_required) throw new HttpError(409, 'This job doesn’t use upfront escrow');
  if (db.prepare("SELECT 1 FROM contracts WHERE job_id = ? AND status IN ('offered','accepted')").get(j.id))
    throw new HttpError(409, 'Withdraw or finish your open offers on this job first');
  const amount = j.escrow_balance_cents;
  if (amount <= 0) throw new HttpError(409, 'There is no unused money in this job’s escrow');
  db.transaction(() => {
    db.prepare("UPDATE jobs SET escrow_balance_cents = 0, escrow_refund_cents = escrow_refund_cents + ?, status = 'closed' WHERE id = ?").run(amount, j.id);
    db.prepare('INSERT INTO escrow_refunds (job_id, client_id, amount_cents) VALUES (?,?,?)').run(j.id, j.client_id, amount);
  })();
  audit(userId, 'escrow.refund_requested', j.id, { amount_cents: amount });
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all())
    notify(a.id, 'payment', `Escrow refund due: R${(amount / 100).toLocaleString('en-ZA')} for job #${j.id} "${j.title}".`, '#admin/payments', userId);
  return amount;
}

module.exports = { PERIODS, PERIOD_LABEL, minEscrowCents, summary, startDeposit, markDepositPaid, fundContractFromJob, requestRefund };
