const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const { requireEmailVerified, HttpError, auth, requireRole, validate, z } = require('../util');
const { company, notify, calcFees, paymentsMode, markFunded, contractEvent, getOrCreateConversation, baseUrl } = require('../services');
const K = require('../kyc');
const L = (id) => `#contracts/${id}`;
const milestones = (id) => db.prepare('SELECT * FROM contract_milestones WHERE contract_id = ? ORDER BY position').all(id);

router.use(auth());

const SELECT = `SELECT c.*, j.title AS job_title, cu.name AS client_name, tu.name AS talent_name
  FROM contracts c JOIN jobs j ON j.id = c.job_id JOIN users cu ON cu.id = c.client_id JOIN users tu ON tu.id = c.talent_id`;

function load(req, id, role) {
  const c = db.prepare(`${SELECT} WHERE c.id = ?`).get(id);
  if (!c) throw new HttpError(404, 'Contract not found');
  const isAdmin = req.user.role === 'admin';
  const isParty = c.client_id === req.user.id || c.talent_id === req.user.id;
  if (!isParty && !isAdmin) throw new HttpError(403, 'This contract belongs to other accounts');
  if (role === 'client' && c.client_id !== req.user.id) throw new HttpError(403, 'Only the client can do this');
  if (role === 'talent' && c.talent_id !== req.user.id) throw new HttpError(403, 'Only the professional can do this');
  return c;
}
const need = (c, ...statuses) => { if (!statuses.includes(c.status)) throw new HttpError(409, `Not possible while the contract is "${c.status}"`); };
const setStatus = (id, status, extra = '') => db.prepare(`UPDATE contracts SET status = ?, updated_at = datetime('now')${extra} WHERE id = ?`).run(status, id);

router.get('/', (req, res) => {
  const col = req.user.role === 'talent' ? 'talent_id' : 'client_id';
  res.json({ data: db.prepare(`${SELECT} WHERE c.${col} = ? ORDER BY c.updated_at DESC`).all(req.user.id) });
});

// Client sends an offer: directly, or by awarding a bid (application_id). Optional milestones split the price.
router.post('/', requireRole('client'), requireEmailVerified, validate(z.object({
  job_id: z.number().int().optional(), talent_id: z.number().int().optional(), application_id: z.number().int().optional(),
  amount: z.number().int().min(50).max(1000000).optional(), description: z.string().trim().min(5).max(2000),
  milestones: z.array(z.object({ title: z.string().trim().min(2).max(120), amount: z.number().int().min(50).max(1000000) })).max(10).optional(),
})), (req, res) => {
  K.requireVerified(req.user.id, 'send offers');
  let { job_id, talent_id, amount, description, milestones: ms, application_id } = req.body;
  if (application_id) {
    const a = db.prepare('SELECT a.*, j.client_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?').get(application_id);
    if (!a || a.client_id !== req.user.id) throw new HttpError(404, 'Bid not found on your jobs');
    if (a.status === 'withdrawn') throw new HttpError(409, 'This bid was withdrawn');
    job_id = a.job_id; talent_id = a.user_id; amount = amount || a.bid_amount;
  }
  if (!job_id || !talent_id) throw new HttpError(400, 'Choose a job and a professional');
  if (ms?.length) amount = ms.reduce((t, m) => t + m.amount, 0);
  if (!amount || amount < 50) throw new HttpError(400, 'Enter an amount of at least R50');
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND client_id = ?').get(job_id, req.user.id);
  if (!job) throw new HttpError(404, 'Job not found on your account');
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'talent' AND status = 'active'").get(talent_id)) throw new HttpError(404, 'Professional not found');
  if (db.prepare("SELECT 1 FROM contracts WHERE job_id = ? AND talent_id = ? AND status IN ('offered','accepted','funded','delivered','disputed')").get(job_id, talent_id))
    throw new HttpError(409, 'There is already an open contract with this professional for this job');
  const cents = amount * 100, f = calcFees(cents);
  if (job.escrow_required) { // remote jobs: offers must fit inside the money already in escrow
    const open = db.prepare("SELECT IFNULL(SUM(amount_cents),0) n FROM contracts WHERE job_id = ? AND status IN ('offered','accepted')").get(job.id).n;
    const free = job.escrow_balance_cents - open;
    if (cents > free) throw new HttpError(409, `This job has R${(Math.max(free, 0) / 100).toLocaleString('en-ZA')} of escrow available for new offers. Add R${((cents - Math.max(free, 0)) / 100).toLocaleString('en-ZA')} to the job’s escrow, or offer less.`, [{ field: 'top_up_cents', message: String(cents - Math.max(free, 0)) }]);
  }
  const id = db.transaction(() => {
    const cid = db.prepare(`INSERT INTO contracts (job_id,client_id,talent_id,description,amount_cents,commission_cents,vat_cents,payout_cents)
      VALUES (?,?,?,?,?,?,?,?)`).run(job_id, req.user.id, talent_id, description, cents, f.commission_cents, f.vat_cents, f.payout_cents).lastInsertRowid;
    (ms || []).forEach((m, i) => db.prepare('INSERT INTO contract_milestones (contract_id, position, title, amount_cents) VALUES (?,?,?,?)').run(cid, i, m.title, m.amount * 100));
    db.prepare("UPDATE applications SET status = 'hired', updated_at = datetime('now') WHERE job_id = ? AND user_id = ?").run(job_id, talent_id);
    return cid;
  })();
  const c = db.prepare(`${SELECT} WHERE c.id = ?`).get(id);
  notify(talent_id, 'offer', `${c.client_name} sent you an offer for "${job.title}": R${amount.toLocaleString('en-ZA')}.`, L(id), req.user.id);
  contractEvent(c, `Offer sent: R${amount.toLocaleString('en-ZA')}`, req.user.id);
  res.status(201).json({ data: c });
});

// Shared printable receipt layout (contract escrow payments and remote-job escrow deposits).
function receiptHtml(co, no, rows, total) {
  return `<!doctype html><meta charset="utf-8"><title>${no}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1d2b4a}h1{font-size:26px;margin:0}table{width:100%;border-collapse:collapse;margin:18px 0}td{padding:10px 8px;border-bottom:1px solid #e3e8f2}td:first-child{color:#667592;width:34%}.t td{font-weight:700;font-size:18px;border-bottom:0}.m{color:#667592;font-size:13px}@media print{button{display:none}}</style>
<button id="p" style="float:right;padding:8px 16px">Print</button><script>document.getElementById("p").onclick=function(){print()}</script>
<h1>Payment receipt ${no}</h1><p class="m">Issued ${new Date().toLocaleDateString('en-ZA')}</p>
<p><b>${esc(co.name || 'TalentBridge')}</b><br>${esc(co.address)}${co.reg ? '<br>Reg no: ' + esc(co.reg) : ''}${co.vat ? '<br>VAT no: ' + esc(co.vat) : ''}</p>
<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}<tr class="t"><td>Amount received</td><td>${total}</td></tr></table>
<p class="m">TalentBridge holds this money in escrow on your behalf until you approve the work, then pays the professional. This receipt confirms a payment into escrow; it is not a tax invoice for services.</p>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const rand = (cents) => 'R ' + (cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Printable invoice for TalentBridge's service fee plus a statement of the contract. Not legal/tax advice: check format with your accountant.
router.get('/:id/invoice', (req, res) => {
  const c = load(req, req.params.id); need(c, 'released', 'paid_out');
  const co = company(), rate = c.commission_cents ? Math.round((c.vat_cents / c.commission_cents) * 100) : 0;
  const no = 'TB-INV-' + String(c.id).padStart(6, '0');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>${no}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1d2b4a}h1{font-size:26px;margin:0}table{width:100%;border-collapse:collapse;margin:18px 0}td,th{padding:10px 8px;border-bottom:1px solid #e3e8f2;text-align:left}td:last-child,th:last-child{text-align:right}.m{color:#667592;font-size:13px}.t td{font-weight:700;border-bottom:0}@media print{button{display:none}}</style>
<button id="p" style="float:right;padding:8px 16px">Print</button><script>document.getElementById("p").onclick=function(){print()}</script>
<h1>${co.vat ? 'Tax invoice' : 'Invoice'} ${no}</h1><p class="m">Date: ${new Date().toLocaleDateString('en-ZA')} · Contract #${c.id}</p>
<p><b>${esc(co.name || 'TalentBridge')}</b><br>${esc(co.address)}${co.reg ? '<br>Reg no: ' + esc(co.reg) : ''}${co.vat ? '<br>VAT no: ' + esc(co.vat) : ''}</p>
<p><b>Billed to:</b> ${esc(c.talent_name)}<br><span class="m">For: ${esc(c.job_title)} (client: ${esc(c.client_name)})</span></p>
<table><tr><th>Description</th><th>Amount</th></tr>
<tr><td>Platform service fee</td><td>${rand(c.commission_cents)}</td></tr><tr><td>VAT @ ${rate}%</td><td>${rand(c.vat_cents)}</td></tr>
<tr class="t"><td>Total fee</td><td>${rand(c.commission_cents + c.vat_cents)}</td></tr></table>
<h3>Payment statement</h3><table><tr><td>Contract price paid by client</td><td>${rand(c.amount_cents)}</td></tr><tr><td>Less: TalentBridge fee incl. VAT</td><td>−${rand(c.commission_cents + c.vat_cents)}</td></tr><tr class="t"><td>Paid to professional</td><td>${rand(c.payout_cents)}</td></tr></table>
<p class="m">${c.payout_ref ? 'Payout reference: ' + esc(c.payout_ref) : 'Payout pending.'}</p>`);
});

// Receipt for what the client paid into escrow.
router.get('/:id/receipt', (req, res) => {
  const c = load(req, req.params.id);
  if (req.user.id !== c.client_id && req.user.role !== 'admin') throw new HttpError(403, 'Only the client can download this receipt');
  const p = db.prepare("SELECT * FROM payments WHERE contract_id = ? AND status NOT IN ('void','pending','cancelled') ORDER BY id DESC").get(c.id);
  if (!p || p.provider === 'job_escrow') throw new HttpError(404, p ? 'This contract was paid from your job’s upfront escrow; download that receipt from the job.' : 'No payment has been made on this contract yet');
  const co = company(), no = 'TB-RCT-' + String(p.id).padStart(6, '0');
  const st = require('../finance').moneyState(c, 'client');
  res.type('html').send(receiptHtml(co, no, [
    ['Received from', esc(c.client_name)], ['For', `${esc(c.job_title)} (contract #${c.id} with ${esc(c.talent_name)})`],
    ['Paid on', p.paid_at ? new Date(p.paid_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-ZA') : ''], ['Method', { payfast: 'PayFast', manual: 'EFT', paystack: 'Paystack', sandbox: 'Test payment' }[p.provider] || esc(p.provider)],
    ['Reference', esc(p.reference)], ['Status now', esc(st.label)],
  ], rand(p.amount_cents)));
});

router.get('/:id', (req, res) => {
  const c = load(req, req.params.id);
  const F = require('../finance');
  res.json({
    data: c,
    money: { state: F.moneyState(c, req.user.id === c.talent_id ? 'talent' : req.user.id === c.client_id ? 'client' : 'admin'), timeline: F.timeline(c) },
    milestones: milestones(c.id),
    conversation_id: getOrCreateConversation(c.client_id, c.talent_id, c.job_id).id,
    review: db.prepare('SELECT rating, comment FROM reviews WHERE contract_id = ?').get(c.id) || null,
    payment: db.prepare('SELECT provider, reference, status FROM payments WHERE contract_id = ? ORDER BY id DESC').get(c.id) || null,
  });
});

// Client withdraws an offer that has not been accepted yet.
router.post('/:id/withdraw', requireRole('client'), (req, res) => {
  const c = load(req, req.params.id, 'client'); need(c, 'offered', 'accepted');
  db.prepare("UPDATE payments SET status = 'void' WHERE contract_id = ? AND status = 'pending'").run(c.id);
  setStatus(c.id, 'cancelled');
  notify(c.talent_id, 'declined', `${c.client_name} ${c.status === 'accepted' ? 'cancelled the contract before paying' : 'withdrew the offer'} for "${c.job_title}". Nothing was charged.`, L(c.id), c.client_id);
  contractEvent(c, c.status === 'accepted' ? 'Contract cancelled before payment' : 'Offer withdrawn', c.client_id);
  res.json({ ok: true });
});

router.post('/:id/accept', requireRole('talent'), (req, res) => {
  const c = load(req, req.params.id, 'talent'); need(c, 'offered');
  K.requireVerified(req.user.id, 'accept offers');
  if (require('../sponsor').needsSponsorship(req.user.id) && !db.prepare('SELECT remote FROM jobs WHERE id = ?').get(c.job_id)?.remote)
    throw new HttpError(403, 'You need a South African work visa to do on-site work. You can accept remote jobs, or a sponsored job offer from an employer.');
  if (!db.prepare('SELECT 1 FROM bank_accounts WHERE user_id = ?').get(req.user.id)) throw new HttpError(403, 'Add your bank account under Verification before accepting offers, so we can pay you.');
  K.checkContract(c);
  setStatus(c.id, 'accepted');
  const upfront = !!db.prepare('SELECT escrow_required FROM jobs WHERE id = ?').get(c.job_id)?.escrow_required;
  notify(c.client_id, 'accepted', `${c.talent_name} accepted your offer for "${c.job_title}".${upfront ? ' Paid from the job’s escrow, so work can start now.' : ' Fund escrow to start the work.'}`, L(c.id), c.talent_id);
  contractEvent(c, 'Offer accepted', c.talent_id);
  let funded = false;
  if (upfront) { try { funded = require('../escrow').fundContractFromJob({ ...c, status: 'accepted' }); } catch (e) { console.warn('Job escrow funding failed', c.id, e.message); } }
  res.json({ ok: true, funded });
});
router.post('/:id/decline', requireRole('talent'), (req, res) => {
  const c = load(req, req.params.id, 'talent'); need(c, 'offered');
  setStatus(c.id, 'cancelled');
  notify(c.client_id, 'declined', `${c.talent_name} declined your offer for "${c.job_title}".`, L(c.id), c.talent_id);
  contractEvent(c, 'Offer declined', c.talent_id);
  res.json({ ok: true });
});

router.post('/:id/fund', requireRole('client'), async (req, res) => {
  const c = load(req, req.params.id, 'client'); need(c, 'accepted');
  K.requireVerified(req.user.id, 'pay into escrow');
  if (require('../escrow').fundContractFromJob(c)) return res.json({ mode: 'job_escrow', funded: true });
  const mode = paymentsMode();
  const reference = `TB-${c.id}-${crypto.randomBytes(4).toString('hex')}`;
  db.prepare("UPDATE payments SET status = 'void' WHERE contract_id = ? AND status = 'pending'").run(c.id);
  db.prepare('INSERT INTO payments (contract_id,provider,reference,amount_cents) VALUES (?,?,?,?)').run(c.id, mode, reference, c.amount_cents);
  if (mode === 'payfast') {
    const PF = require('../payfast');
    if (!PF.configured()) throw new HttpError(503, 'Card payments are not set up yet. Please contact support.');
    const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id);
    const [first, ...rest] = String(u.name || '').trim().split(/\s+/);
    const out = PF.checkout({ reference, amountCents: c.amount_cents, itemName: `TalentBridge contract #${c.id}`, itemDescription: `Escrow for: ${c.job_title || 'contract'}`,
      buyer: { first, last: rest.join(' '), email: u.email }, contractId: c.id, baseUrl: baseUrl(req) });
    return res.json({ mode, reference, ...out });
  }
  if (mode === 'paystack') {
    const email = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id).email;
    const r = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, amount: c.amount_cents, currency: 'ZAR', reference, callback_url: `${process.env.APP_URL || ''}/app.html` }),
    });
    const j = await r.json();
    if (!j.status) throw new HttpError(502, 'Payment provider error. Please try again.');
    return res.json({ mode, reference, checkout_url: j.data.authorization_url });
  }
  if (mode === 'manual') {
    return res.json({ mode, reference, instructions: `Pay R${(c.amount_cents / 100).toLocaleString('en-ZA')} by EFT using reference ${reference}. TalentBridge confirms receipt, usually within one business day.` });
  }
  res.json({ mode, reference, instructions: 'Sandbox mode: confirm the test payment to continue.' });
});

router.post('/:id/fund/simulate', requireRole('client'), (req, res) => {
  if (paymentsMode() !== 'sandbox') throw new HttpError(404, 'Not available');
  const c = load(req, req.params.id, 'client'); need(c, 'accepted');
  const p = db.prepare("SELECT reference FROM payments WHERE contract_id = ? AND status = 'pending' ORDER BY id DESC").get(c.id);
  if (!p) throw new HttpError(409, 'Start the payment first');
  markFunded(c.id, p.reference); res.json({ ok: true });
});

router.post('/:id/deliver', requireRole('talent'), validate(z.object({ note: z.string().trim().max(2000).default('') })), (req, res) => {
  const c = load(req, req.params.id, 'talent'); need(c, 'funded');
  setStatus(c.id, 'delivered', ", delivered_at = datetime('now'), delivery_note = " + db.prepare('SELECT quote(?) q').get(req.body.note).q);
  notify(c.client_id, 'delivered', `${c.talent_name} delivered the work for "${c.job_title}". Review it and release payment.`, L(c.id), c.talent_id);
  contractEvent(c, 'Work delivered' + (req.body.note ? `: ${req.body.note.slice(0, 200)}` : ''), c.talent_id);
  res.json({ ok: true });
});

router.post('/:id/release', requireRole('client'), (req, res) => {
  const c = load(req, req.params.id, 'client'); need(c, 'delivered');
  db.transaction(() => {
    setStatus(c.id, 'released', ", released_at = datetime('now')");
    db.prepare("UPDATE payments SET status = 'payout_due' WHERE contract_id = ? AND status = 'paid'").run(c.id);
    db.prepare('UPDATE profiles SET jobs_done = jobs_done + 1 WHERE user_id = ?').run(c.talent_id);
  })();
  db.prepare("UPDATE contract_milestones SET status = 'approved', updated_at = datetime('now') WHERE contract_id = ?").run(c.id);
  notify(c.talent_id, 'payment', `${c.client_name} approved your work on "${c.job_title}". Your payout of R${(c.payout_cents / 100).toLocaleString('en-ZA')} is being processed.`, L(c.id), c.client_id);
  contractEvent(c, 'Payment released', c.client_id);
  res.json({ ok: true });
});

router.post('/:id/dispute', validate(z.object({ reason: z.string().trim().min(10).max(2000) })), (req, res) => {
  const c = load(req, req.params.id); need(c, 'funded', 'delivered');
  if (req.user.role === 'admin') throw new HttpError(403, 'Admins resolve disputes, they do not open them');
  db.transaction(() => {
    setStatus(c.id, 'disputed', ", disputed_at = datetime('now')");
    db.prepare("INSERT INTO reports (reporter_id,target_type,target_id,reason) VALUES (?, 'contract', ?, ?)").run(req.user.id, c.id, req.body.reason);
  })();
  const other = req.user.id === c.client_id ? c.talent_id : c.client_id;
  notify(other, 'dispute', `A dispute was opened on contract #${c.id}. TalentBridge will review it and contact you both.`, L(c.id), req.user.id);
  contractEvent(c, 'Dispute opened. TalentBridge support will review.', req.user.id);
  res.json({ ok: true });
});

router.post('/:id/review', requireRole('client'), validate(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).default('') })), (req, res) => {
  const c = load(req, req.params.id, 'client'); need(c, 'released', 'paid_out');
  if (db.prepare('SELECT 1 FROM reviews WHERE contract_id = ?').get(c.id)) throw new HttpError(409, 'You already reviewed this contract');
  db.transaction(() => {
    db.prepare('INSERT INTO reviews (contract_id,reviewer_id,talent_id,rating,comment) VALUES (?,?,?,?,?)').run(c.id, req.user.id, c.talent_id, req.body.rating, req.body.comment);
    const p = db.prepare('SELECT rating, jobs_done FROM profiles WHERE user_id = ?').get(c.talent_id);
    const n = Math.max(p.jobs_done, 1);
    db.prepare('UPDATE profiles SET rating = ? WHERE user_id = ?').run(Math.round(((p.rating * (n - 1) + req.body.rating) / n) * 10) / 10, c.talent_id);
  })();
  notify(c.talent_id, 'review', `${c.client_name} left you a ${req.body.rating}-star review.`, '#profile', c.client_id);
  res.status(201).json({ ok: true });
});

// Milestones: the professional submits each one, the client approves it. Escrow is released once at the end.
router.post('/:id/milestones/:mid/submit', requireRole('talent'), (req, res) => {
  const c = load(req, req.params.id, 'talent'); need(c, 'funded');
  const m = db.prepare('SELECT * FROM contract_milestones WHERE id = ? AND contract_id = ?').get(req.params.mid, c.id);
  if (!m) throw new HttpError(404, 'Milestone not found');
  if (m.status !== 'pending') throw new HttpError(409, 'This milestone was already submitted');
  db.prepare("UPDATE contract_milestones SET status = 'submitted', updated_at = datetime('now') WHERE id = ?").run(m.id);
  notify(c.client_id, 'milestone', `${c.talent_name} completed milestone "${m.title}". Review and approve it.`, L(c.id), c.talent_id);
  contractEvent(c, `Milestone completed: ${m.title}`, c.talent_id);
  res.json({ data: milestones(c.id) });
});
router.post('/:id/milestones/:mid/approve', requireRole('client'), (req, res) => {
  const c = load(req, req.params.id, 'client'); need(c, 'funded', 'delivered');
  const m = db.prepare('SELECT * FROM contract_milestones WHERE id = ? AND contract_id = ?').get(req.params.mid, c.id);
  if (!m) throw new HttpError(404, 'Milestone not found');
  if (m.status !== 'submitted') throw new HttpError(409, 'Only submitted milestones can be approved');
  db.prepare("UPDATE contract_milestones SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(m.id);
  notify(c.talent_id, 'milestone', `${c.client_name} approved milestone "${m.title}".`, L(c.id), c.client_id);
  contractEvent(c, `Milestone approved: ${m.title}`, c.client_id);
  res.json({ data: milestones(c.id) });
});

// Older clients posted contract messages here; they now go into the shared inbox thread.
router.post('/:id/messages', validate(z.object({ body: z.string().trim().min(1).max(2000) })), (req, res) => {
  const c = load(req, req.params.id);
  if (req.user.role === 'admin') throw new HttpError(403, 'Admins cannot post in member conversations');
  const { postMessage } = require('../services');
  const msg = postMessage(getOrCreateConversation(c.client_id, c.talent_id, c.job_id), req.user.id, req.body.body);
  res.status(201).json({ ok: true, data: msg });
});

module.exports = router;
module.exports.receiptHtml = receiptHtml;
