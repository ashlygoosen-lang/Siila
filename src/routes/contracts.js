const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const { HttpError, auth, requireRole, validate, z } = require('../util');
const { notify, calcFees, paymentsMode, markFunded } = require('../services');

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

router.post('/', requireRole('client'), validate(z.object({
  job_id: z.number().int(), talent_id: z.number().int(),
  amount: z.number().int().min(50).max(1000000), description: z.string().trim().min(5).max(2000),
})), (req, res) => {
  const { job_id, talent_id, amount, description } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND client_id = ?').get(job_id, req.user.id);
  if (!job) throw new HttpError(404, 'Job not found on your account');
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'talent' AND status = 'active'").get(talent_id)) throw new HttpError(404, 'Professional not found');
  const cents = amount * 100, f = calcFees(cents);
  const id = db.prepare(`INSERT INTO contracts (job_id,client_id,talent_id,description,amount_cents,commission_cents,vat_cents,payout_cents)
    VALUES (?,?,?,?,?,?,?,?)`).run(job_id, req.user.id, talent_id, description, cents, f.commission_cents, f.vat_cents, f.payout_cents).lastInsertRowid;
  db.prepare("UPDATE applications SET status = 'hired' WHERE job_id = ? AND user_id = ?").run(job_id, talent_id);
  notify(talent_id, 'contract', `New offer for "${job.title}": R${amount.toLocaleString('en-ZA')}. Review it in your contracts.`);
  res.status(201).json({ data: db.prepare(`${SELECT} WHERE c.id = ?`).get(id) });
});

router.get('/:id', (req, res) => {
  const c = load(req, req.params.id);
  res.json({
    data: c,
    messages: db.prepare('SELECT m.*, u.name FROM messages m JOIN users u ON u.id = m.sender_id WHERE contract_id = ? ORDER BY m.id').all(c.id),
    review: db.prepare('SELECT rating, comment FROM reviews WHERE contract_id = ?').get(c.id) || null,
    payment: db.prepare('SELECT provider, reference, status FROM payments WHERE contract_id = ? ORDER BY id DESC').get(c.id) || null,
  });
});

router.post('/:id/accept', requireRole('talent'), (req, res) => {
  const c = load(req, req.params.id, 'talent'); need(c, 'offered');
  setStatus(c.id, 'accepted'); notify(c.client_id, 'contract', `${c.talent_name} accepted contract #${c.id}. You can now fund it.`);
  res.json({ ok: true });
});
router.post('/:id/decline', requireRole('talent'), (req, res) => {
  const c = load(req, req.params.id, 'talent'); need(c, 'offered');
  setStatus(c.id, 'cancelled'); notify(c.client_id, 'contract', `${c.talent_name} declined contract #${c.id}.`);
  res.json({ ok: true });
});

router.post('/:id/fund', requireRole('client'), async (req, res) => {
  const c = load(req, req.params.id, 'client'); need(c, 'accepted');
  const mode = paymentsMode();
  const reference = `SIIRA-${c.id}-${crypto.randomBytes(4).toString('hex')}`;
  db.prepare("UPDATE payments SET status = 'void' WHERE contract_id = ? AND status = 'pending'").run(c.id);
  db.prepare('INSERT INTO payments (contract_id,provider,reference,amount_cents) VALUES (?,?,?,?)').run(c.id, mode, reference, c.amount_cents);
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
    return res.json({ mode, reference, instructions: `Pay R${(c.amount_cents / 100).toLocaleString('en-ZA')} by EFT using reference ${reference}. SIIRA confirms receipt, usually within one business day.` });
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
  setStatus(c.id, 'delivered', ', delivery_note = ' + db.prepare('SELECT quote(?) q').get(req.body.note).q);
  notify(c.client_id, 'contract', `${c.talent_name} marked contract #${c.id} as delivered. Please review and approve.`);
  res.json({ ok: true });
});

router.post('/:id/release', requireRole('client'), (req, res) => {
  const c = load(req, req.params.id, 'client'); need(c, 'delivered');
  db.transaction(() => {
    setStatus(c.id, 'released');
    db.prepare("UPDATE payments SET status = 'payout_due' WHERE contract_id = ? AND status = 'paid'").run(c.id);
    db.prepare('UPDATE profiles SET jobs_done = jobs_done + 1 WHERE user_id = ?').run(c.talent_id);
  })();
  notify(c.talent_id, 'payment', `Contract #${c.id} approved. Your payout of R${(c.payout_cents / 100).toLocaleString('en-ZA')} is being processed.`);
  res.json({ ok: true });
});

router.post('/:id/dispute', validate(z.object({ reason: z.string().trim().min(10).max(2000) })), (req, res) => {
  const c = load(req, req.params.id); need(c, 'funded', 'delivered');
  if (req.user.role === 'admin') throw new HttpError(403, 'Admins resolve disputes, they do not open them');
  db.transaction(() => {
    setStatus(c.id, 'disputed');
    db.prepare("INSERT INTO reports (reporter_id,target_type,target_id,reason) VALUES (?, 'contract', ?, ?)").run(req.user.id, c.id, req.body.reason);
  })();
  const other = req.user.id === c.client_id ? c.talent_id : c.client_id;
  notify(other, 'dispute', `A dispute was opened on contract #${c.id}. SIIRA will review it and contact you both.`);
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
  notify(c.talent_id, 'review', `${c.client_name} left you a ${req.body.rating}-star review.`);
  res.status(201).json({ ok: true });
});

router.post('/:id/messages', validate(z.object({ body: z.string().trim().min(1).max(2000) })), (req, res) => {
  const c = load(req, req.params.id);
  db.prepare('INSERT INTO messages (contract_id,sender_id,body) VALUES (?,?,?)').run(c.id, req.user.id, req.body.body);
  for (const uid of [c.client_id, c.talent_id]) if (uid !== req.user.id) notify(uid, 'message', `New message on contract #${c.id}.`);
  res.status(201).json({ ok: true });
});

module.exports = router;
