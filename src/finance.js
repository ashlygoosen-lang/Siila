// One place that explains money to each party: what a client has paid and where it is, what a professional
// has earned and when it arrives, and what TalentBridge holds, owes and has earned. Every screen reads from here
// so the numbers always agree.
const db = require('./db');

const sum = (sql, ...a) => db.prepare(sql).get(...a).n || 0;
const TO_JOB = 'Returned to job escrow';

// Plain-language status of the money on one contract, from each side's point of view.
function moneyState(c, role) {
  const R = (x) => 'R' + (x / 100).toLocaleString('en-ZA');
  const t = role === 'talent';
  switch (c.status) {
    case 'offered': return { key: 'none', label: 'Not paid yet', detail: t ? 'Accept the offer, then the client pays into escrow.' : 'Pay into escrow after the professional accepts.' };
    case 'accepted': return { key: 'due', label: t ? 'Waiting for the client to pay' : 'Payment due', detail: t ? 'Don’t start work until the escrow is funded.' : `Pay ${R(c.amount_cents)} into escrow so work can start.` };
    case 'funded': case 'delivered': return { key: 'held', label: 'Held in escrow', detail: t ? `${R(c.payout_cents)} is reserved for you and released when the client approves the work.` : `${R(c.amount_cents)} is held safely until you approve the work.` };
    case 'disputed': return { key: 'held', label: 'On hold: dispute', detail: 'The money stays in escrow while TalentBridge reviews the dispute.' };
    case 'released': return { key: 'payout', label: t ? 'Released, payout on the way' : 'Released to the professional', detail: t ? `${R(c.payout_cents)} will be paid to your bank account, usually within 2 business days.` : 'You approved the work. The professional is being paid.' };
    case 'paid_out': return { key: 'done', label: t ? 'Paid to you' : 'Paid to the professional', detail: t ? `${R(c.payout_cents)} paid${c.payout_ref ? `, reference ${c.payout_ref}` : ''}.` : 'This contract is complete.' };
    case 'refunded': if (c.refund_ref === TO_JOB) return { key: 'refunded', label: t ? 'Returned to the client' : 'Back in your job’s escrow', detail: t ? 'The client got the money back after the dispute.' : `${R(c.amount_cents)} went back into this job’s upfront escrow. Use it for another hire or ask for it back.` };
      return { key: c.refunded_at ? 'refunded' : 'refund', label: c.refunded_at ? (t ? 'Refunded to the client' : 'Refunded') : (t ? 'Being refunded to the client' : 'Refund on the way'),
      detail: t ? 'The client was refunded after the dispute.' : c.refunded_at ? `${R(c.amount_cents)} refunded${c.refund_ref ? `, reference ${c.refund_ref}` : ''}.` : `${R(c.amount_cents)} will be refunded to your original payment method, usually within 5 business days.` };
    case 'cancelled': return { key: 'none', label: 'Cancelled', detail: 'No money changed hands.' };
    default: return { key: 'none', label: c.status, detail: '' };
  }
}

// Dated steps the money went through on one contract.
function timeline(c) {
  const pay = db.prepare("SELECT provider, reference, paid_at FROM payments WHERE contract_id = ? AND status != 'void' AND status != 'pending' ORDER BY id DESC").get(c.id);
  const steps = [];
  if (c.funded_at || pay?.paid_at) steps.push({ key: 'funded', label: pay?.provider === 'job_escrow' ? 'Paid from the job’s upfront escrow' : 'Paid into escrow', at: c.funded_at || pay?.paid_at, ref: pay?.reference || '' });
  if (c.delivered_at) steps.push({ key: 'delivered', label: 'Work delivered', at: c.delivered_at });
  if (c.disputed_at) steps.push({ key: 'disputed', label: 'Dispute opened', at: c.disputed_at });
  if (c.released_at) steps.push({ key: 'released', label: 'Payment released', at: c.released_at });
  if (c.paid_out_at) steps.push({ key: 'paid_out', label: 'Paid to the professional', at: c.paid_out_at, ref: c.payout_ref });
  if (c.status === 'refunded') steps.push({ key: 'refunded', label: c.refund_ref === TO_JOB ? 'Returned to the job’s escrow' : c.refunded_at ? 'Refunded to the client' : 'Refund approved', at: c.refunded_at || c.updated_at, ref: c.refund_ref });
  return steps;
}

const CSEL = `SELECT c.*, j.title job_title, cu.name client_name, tu.name talent_name FROM contracts c JOIN jobs j ON j.id = c.job_id
  JOIN users cu ON cu.id = c.client_id JOIN users tu ON tu.id = c.talent_id`;

function forClient(uid) {
  const cs = db.prepare(`${CSEL} WHERE c.client_id = ? AND c.status NOT IN ('offered','cancelled') ORDER BY c.updated_at DESC`).all(uid);
  const deposits = db.prepare(`SELECT d.*, j.title job_title FROM job_deposits d JOIN jobs j ON j.id = d.job_id WHERE d.client_id = ? AND d.status IN ('paid','pending') ORDER BY d.id DESC`).all(uid);
  const jobRefunds = db.prepare('SELECT r.*, j.title job_title FROM escrow_refunds r JOIN jobs j ON j.id = r.job_id WHERE r.client_id = ? ORDER BY r.id DESC').all(uid);
  const direct = (st) => sum(`SELECT SUM(p.amount_cents) n FROM payments p JOIN contracts c ON c.id = p.contract_id WHERE c.client_id = ? AND p.provider != 'job_escrow' AND p.status IN (${st})`, uid);
  const summary = {
    paid_in_cents: direct("'paid','payout_due','paid_out','refund_due','refunded'") + sum("SELECT SUM(amount_cents) n FROM job_deposits WHERE client_id = ? AND status = 'paid'", uid),
    held_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE client_id = ? AND status IN ('funded','delivered','disputed')", uid),
    job_escrow_cents: sum('SELECT SUM(escrow_balance_cents) n FROM jobs WHERE client_id = ? AND escrow_required = 1', uid),
    released_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE client_id = ? AND status IN ('released','paid_out')", uid),
    refunded_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE client_id = ? AND status = 'refunded' AND refunded_at IS NOT NULL AND refund_ref != ?", uid, TO_JOB) + sum("SELECT SUM(amount_cents) n FROM escrow_refunds WHERE client_id = ? AND status = 'refunded'", uid),
    refund_pending_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE client_id = ? AND status = 'refunded' AND refunded_at IS NULL", uid) + sum("SELECT SUM(amount_cents) n FROM escrow_refunds WHERE client_id = ? AND status = 'due'", uid),
    due_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE client_id = ? AND status = 'accepted'", uid),
  };
  const rows = [];
  for (const c of cs) {
    const pay = db.prepare("SELECT provider, reference, paid_at FROM payments WHERE contract_id = ? AND status NOT IN ('void','pending','cancelled') ORDER BY id DESC").get(c.id);
    rows.push({ kind: 'contract', id: c.id, at: c.paid_out_at || c.refunded_at || c.released_at || c.funded_at || c.updated_at, title: c.job_title, who: c.talent_name, amount_cents: c.amount_cents,
      status: c.status, state: moneyState(c, 'client'), reference: pay?.reference || '', via_job_escrow: pay?.provider === 'job_escrow', link: `#contracts/${c.id}`, receipt: !!pay && pay.provider !== 'job_escrow' });
  }
  for (const d of deposits) rows.push({ kind: 'job_deposit', id: d.id, at: d.paid_at || d.created_at, title: d.job_title, who: 'Upfront escrow', amount_cents: d.amount_cents, status: d.status,
    state: d.status === 'paid' ? { key: 'held', label: 'In the job’s escrow', detail: 'Used to pay contracts on this remote job.' } : { key: 'due', label: d.provider === 'manual' ? 'Waiting for your EFT' : 'Payment not completed', detail: '' },
    reference: d.reference, link: `#job/${d.job_id}`, receipt: d.status === 'paid' ? `/api/jobs/${d.job_id}/escrow/receipt/${d.id}` : '' });
  for (const r of jobRefunds) rows.push({ kind: 'job_refund', id: r.id, at: r.refunded_at || r.created_at, title: r.job_title, who: 'Unused escrow', amount_cents: -r.amount_cents, status: r.status,
    state: r.status === 'refunded' ? { key: 'refunded', label: 'Refunded', detail: r.reference ? `Reference ${r.reference}` : '' } : { key: 'refund', label: 'Refund on the way', detail: 'Usually within 5 business days.' },
    reference: r.reference, link: `#job/${r.job_id}` });
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { role: 'client', summary, rows };
}

function forTalent(uid) {
  const cs = db.prepare(`${CSEL} WHERE c.talent_id = ? AND c.status NOT IN ('offered','cancelled') ORDER BY c.updated_at DESC`).all(uid);
  const bank = db.prepare('SELECT bank, account_last4, account_type, changed_at FROM bank_accounts WHERE user_id = ?').get(uid) || null;
  const K = require('./kyc');
  const summary = {
    paid_out_cents: sum("SELECT SUM(payout_cents) n FROM contracts WHERE talent_id = ? AND status = 'paid_out'", uid),
    on_the_way_cents: sum("SELECT SUM(payout_cents) n FROM contracts WHERE talent_id = ? AND status = 'released'", uid),
    in_escrow_cents: sum("SELECT SUM(payout_cents) n FROM contracts WHERE talent_id = ? AND status IN ('funded','delivered')", uid),
    on_hold_cents: sum("SELECT SUM(payout_cents) n FROM contracts WHERE talent_id = ? AND status = 'disputed'", uid),
    awaiting_payment_cents: sum("SELECT SUM(payout_cents) n FROM contracts WHERE talent_id = ? AND status = 'accepted'", uid),
    fees_cents: sum("SELECT SUM(commission_cents + vat_cents) n FROM contracts WHERE talent_id = ? AND status IN ('released','paid_out')", uid),
    gross_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE talent_id = ? AND status IN ('released','paid_out')", uid),
  };
  // Why a released payout can't be sent yet, in words the professional can act on.
  const holds = [];
  for (const c of cs.filter(x => x.status === 'released')) for (const b of K.payoutBlockers(c)) {
    const msg = /bank account on file/.test(b) ? 'Add your bank account under Verification so we can pay you.' : /not verified/.test(b) ? 'Finish identity verification so we can pay you.'
      : /Bank details changed/.test(b) ? 'Your bank details changed recently. For your safety, payouts wait 24 hours after a change.' : 'Our team is doing a routine check before paying out. No action is needed.';
    if (!holds.includes(msg)) holds.push(msg);
  }
  const rows = cs.map(c => ({ kind: 'contract', id: c.id, at: c.paid_out_at || c.released_at || c.funded_at || c.updated_at, title: c.job_title, who: c.client_name,
    gross_cents: c.amount_cents, fee_cents: c.commission_cents + c.vat_cents, net_cents: c.payout_cents, status: c.status, state: moneyState(c, 'talent'),
    payout_ref: c.payout_ref || '', paid_out_at: c.paid_out_at, link: `#contracts/${c.id}`, invoice: ['released', 'paid_out'].includes(c.status) }));
  return { role: 'talent', summary, holds, bank: bank && { bank: bank.bank, last4: bank.account_last4, type: bank.account_type }, rows };
}

function forAdmin() {
  const received = sum("SELECT SUM(amount_cents) n FROM payments WHERE provider != 'job_escrow' AND status IN ('paid','payout_due','paid_out','refund_due','refunded')")
    + sum("SELECT SUM(amount_cents) n FROM job_deposits WHERE status = 'paid'");
  return {
    received_cents: received,
    held_contracts_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE status IN ('funded','delivered','disputed')"),
    held_job_escrow_cents: sum('SELECT SUM(escrow_balance_cents) n FROM jobs WHERE escrow_required = 1'),
    disputed_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE status = 'disputed'"),
    payouts_due_cents: sum("SELECT SUM(payout_cents) n FROM contracts WHERE status = 'released'"),
    payouts_due: sum("SELECT COUNT(*) n FROM contracts WHERE status = 'released'"),
    refunds_due_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE status = 'refunded' AND refunded_at IS NULL") + sum("SELECT SUM(amount_cents) n FROM escrow_refunds WHERE status = 'due'"),
    refunds_due: sum("SELECT COUNT(*) n FROM contracts WHERE status = 'refunded' AND refunded_at IS NULL") + sum("SELECT COUNT(*) n FROM escrow_refunds WHERE status = 'due'"),
    paid_out_cents: sum("SELECT SUM(payout_cents) n FROM contracts WHERE status = 'paid_out'"),
    refunded_cents: sum("SELECT SUM(amount_cents) n FROM contracts WHERE status = 'refunded' AND refunded_at IS NOT NULL AND refund_ref != ?", TO_JOB) + sum("SELECT SUM(amount_cents) n FROM escrow_refunds WHERE status = 'refunded'"),
    revenue_cents: sum("SELECT SUM(commission_cents) n FROM contracts WHERE status IN ('released','paid_out')"),
    vat_cents: sum("SELECT SUM(vat_cents) n FROM contracts WHERE status IN ('released','paid_out')"),
    eft_to_confirm: sum("SELECT COUNT(*) n FROM payments p JOIN contracts c ON c.id = p.contract_id WHERE c.status = 'accepted' AND p.status = 'pending' AND p.provider = 'manual'")
      + sum("SELECT COUNT(*) n FROM job_deposits WHERE status = 'pending' AND provider = 'manual'"),
  };
}

module.exports = { moneyState, timeline, forClient, forTalent, forAdmin };
