const router = require('express').Router();
const db = require('../db');
const { HttpError, auth, requireRole, validate, z } = require('../util');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, notify, audit, setting, markFunded } = require('../services');

router.use(auth(), requireRole('admin'));
const n = (sql, ...a) => db.prepare(sql).get(...a).n || 0;
const like = (q) => `%${q || ''}%`;

router.get('/readiness', (_req, res) => res.json({ data: require('../readiness').checks() }));

router.get('/overview', (_req, res) => {
  res.json({
    talent: n("SELECT COUNT(*) n FROM users WHERE role='talent' AND status='active'"),
    clients: n("SELECT COUNT(*) n FROM users WHERE role='client' AND status='active'"),
    signups_30d: n("SELECT COUNT(*) n FROM users WHERE created_at >= datetime('now','-30 days')"),
    jobs_open: n("SELECT COUNT(*) n FROM jobs WHERE status='open'"),
    pending_verifications: n("SELECT COUNT(*) n FROM verifications WHERE status='pending'"),
    open_reports: n("SELECT COUNT(*) n FROM reports WHERE status IN ('open','reviewing')"),
    new_leads: n("SELECT COUNT(*) n FROM hire_requests WHERE status='new'"),
    escrow_deposits_to_confirm: n("SELECT COUNT(*) n FROM job_deposits WHERE status='pending' AND provider='manual'"),
    escrow_refunds_due: n("SELECT COUNT(*) n FROM escrow_refunds WHERE status='due'"),
    payments_to_confirm: n("SELECT COUNT(*) n FROM contracts c JOIN payments p ON p.contract_id=c.id WHERE c.status='accepted' AND p.status='pending' AND p.provider='manual'"),
    payouts_due: n("SELECT COUNT(*) n FROM contracts WHERE status='released'"),
    payouts_due_cents: n("SELECT SUM(payout_cents) n FROM contracts WHERE status='released'"),
    contract_refunds_due: n("SELECT COUNT(*) n FROM contracts WHERE status='refunded' AND refunded_at IS NULL"),
    escrow_cents: n("SELECT SUM(amount_cents) n FROM contracts WHERE status IN ('funded','delivered','disputed')"),
    gmv_cents: n("SELECT SUM(amount_cents) n FROM contracts WHERE status IN ('funded','delivered','released','paid_out','disputed')"),
    revenue_cents: n("SELECT SUM(commission_cents) n FROM contracts WHERE status IN ('released','paid_out')"),
    vat_cents: n("SELECT SUM(vat_cents) n FROM contracts WHERE status IN ('released','paid_out')"),
    new_messages: n("SELECT COUNT(*) n FROM contact_messages WHERE status='new'"),
    contracts_active: n("SELECT COUNT(*) n FROM contracts WHERE status IN ('accepted','funded','delivered')"),
    kyc_pending: n("SELECT COUNT(*) n FROM users WHERE kyc_status = 'pending'"),
    intl_requests: n("SELECT COUNT(*) n FROM jobs WHERE intl_status = 'requested'"),
    visa_cases_active: n("SELECT COUNT(*) n FROM sponsorships WHERE status IN ('accepted','documents','submitted')"),
    quals_pending: n("SELECT COUNT(*) n FROM qualifications q JOIN users u ON u.id = q.user_id WHERE q.status IN ('pending','in_progress') AND u.kyc_status IN ('pending','approved')"),
    risk_open: n("SELECT COUNT(*) n FROM risk_flags WHERE status = 'open'"),
    risk_high: n("SELECT COUNT(*) n FROM risk_flags WHERE status = 'open' AND severity = 'high'"),
  });
});

router.get('/users', validate(z.object({ q: z.string().max(80).optional(), role: z.enum(['talent', 'client', 'admin']).optional(), status: z.string().optional() }), 'query'), (req, res) => {
  const { q, role, status } = req.q;
  const w = ['(u.name LIKE ? OR u.email LIKE ?)'], a = [like(q), like(q)];
  if (role) { w.push('u.role = ?'); a.push(role); }
  if (status) { w.push('u.status = ?'); a.push(status); }
  res.json({ data: db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.role,u.status,u.created_at,COALESCE(p.verified,0) verified FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE ${w.join(' AND ')} ORDER BY u.id DESC LIMIT 200`).all(...a) });
});
router.patch('/users/:id', validate(z.object({ status: z.enum(['active', 'suspended']) })), (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'You cannot change your own status');
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw new HttpError(404, 'User not found');
  if (u.role === 'admin') throw new HttpError(403, 'Admin accounts cannot be suspended here');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  audit(req.user.id, `user.${req.body.status}`, req.params.id); res.json({ ok: true });
});

router.get('/verifications', (req, res) => {
  const st = req.query.status || 'pending';
  res.json({ data: db.prepare(`SELECT v.*, u.name, u.email, u.role FROM verifications v JOIN users u ON u.id=v.user_id WHERE v.status = ? ORDER BY v.id DESC LIMIT 200`).all(st) });
});
router.post('/verifications/:id/decision', validate(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).default('') })), (req, res) => {
  const v = db.prepare("SELECT * FROM verifications WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!v) throw new HttpError(404, 'No pending request');
  db.transaction(() => {
    db.prepare("UPDATE verifications SET status=?, review_note=?, reviewed_at=datetime('now') WHERE id=?").run(req.body.decision, req.body.note, v.id);
    if (req.body.decision === 'approved') db.prepare('UPDATE profiles SET verified = 1 WHERE user_id = ?').run(v.user_id);
    db.prepare("UPDATE verifications SET doc_path = '' WHERE id = ?").run(v.id);
  })();
  if (v.doc_path) fs.unlink(path.join(UPLOAD_DIR, path.basename(v.doc_path)), () => {}); // delete the document once reviewed (POPIA)
  notify(v.user_id, 'verification', req.body.decision === 'approved' ? 'You are verified. Your badge now shows on your profile.' : `Verification not approved. ${req.body.note}`, '#profile');
  audit(req.user.id, `verification.${req.body.decision}`, v.id); res.json({ ok: true });
});

router.get('/verifications/:id/document', (req, res) => {
  const v = db.prepare('SELECT doc_path, doc_mime FROM verifications WHERE id = ?').get(req.params.id);
  if (!v || !v.doc_path) throw new HttpError(404, 'No document on file');
  audit(req.user.id, 'verification.document_viewed', req.params.id);
  res.type(v.doc_mime).setHeader('Content-Disposition', 'inline');
  res.sendFile(path.join(UPLOAD_DIR, path.basename(v.doc_path)));
});

router.get('/inbox', (_req, res) => res.json({ data: db.prepare('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 200').all() }));
router.patch('/inbox/:id', validate(z.object({ status: z.enum(['new', 'handled']) })), (req, res) => {
  db.prepare('UPDATE contact_messages SET status = ? WHERE id = ?').run(req.body.status, req.params.id); res.json({ ok: true });
});

// Accountant export (CSV). Cells starting with = + - @ are prefixed to stop spreadsheet formula injection.
router.get('/export/contracts.csv', (_req, res) => {
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const rows = db.prepare(`SELECT c.id, c.created_at, c.updated_at, j.title, cu.name client, tu.name talent, c.amount_cents, c.commission_cents, c.vat_cents, c.payout_cents, c.status, c.payout_ref
    FROM contracts c JOIN jobs j ON j.id=c.job_id JOIN users cu ON cu.id=c.client_id JOIN users tu ON tu.id=c.talent_id ORDER BY c.id`).all();
  const head = ['Contract', 'Created', 'Updated', 'Job', 'Client', 'Professional', 'Amount (R)', 'Commission excl VAT (R)', 'VAT (R)', 'Payout (R)', 'Status', 'Payout ref'];
  const r2 = (c) => (c / 100).toFixed(2);
  const lines = [head.map(cell).join(',')].concat(rows.map(r => [r.id, r.created_at, r.updated_at, r.title, r.client, r.talent, r2(r.amount_cents), r2(r.commission_cents), r2(r.vat_cents), r2(r.payout_cents), r.status, r.payout_ref].map(cell).join(',')));
  res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="talentbridge-contracts.csv"');
  res.send('\uFEFF' + lines.join('\r\n'));
});

router.get('/jobs', (req, res) => {
  const w = req.query.status ? 'WHERE j.status = ?' : '', a = req.query.status ? [req.query.status] : [];
  res.json({ data: db.prepare(`SELECT j.id,j.title,j.category,j.type,j.city,j.province,j.status,j.featured,j.created_at,u.name client_name,
    (SELECT COUNT(*) FROM applications x WHERE x.job_id=j.id) applicants FROM jobs j JOIN users u ON u.id=j.client_id ${w} ORDER BY j.id DESC LIMIT 200`).all(...a) });
});
router.patch('/jobs/:id', validate(z.object({ status: z.enum(['open', 'closed']).optional(), featured: z.boolean().optional(), moderation_note: z.string().max(500).optional() })), (req, res) => {
  const b = req.body, sets = [], args = [];
  if (b.status) { sets.push('status=?'); args.push(b.status); }
  if (b.featured !== undefined) { sets.push('featured=?'); args.push(b.featured ? 1 : 0); }
  if (b.moderation_note !== undefined) { sets.push('moderation_note=?'); args.push(b.moderation_note); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  if (!db.prepare(`UPDATE jobs SET ${sets.join(',')} WHERE id=?`).run(...args, req.params.id).changes) throw new HttpError(404, 'Job not found');
  audit(req.user.id, 'job.update', req.params.id, b); res.json({ ok: true });
});

router.get('/leads', (req, res) => {
  res.json({ data: db.prepare(`SELECT h.*, u.name talent_name FROM hire_requests h JOIN users u ON u.id=h.talent_id ${req.query.status ? 'WHERE h.status = ?' : ''} ORDER BY h.id DESC LIMIT 200`).all(...(req.query.status ? [req.query.status] : [])) });
});
router.patch('/leads/:id', validate(z.object({ status: z.enum(['new', 'contacted', 'closed']), admin_note: z.string().max(500).default('') })), (req, res) => {
  db.prepare('UPDATE hire_requests SET status=?, admin_note=? WHERE id=?').run(req.body.status, req.body.admin_note, req.params.id); res.json({ ok: true });
});

router.get('/contracts', (_req, res) => {
  res.json({ data: db.prepare(`SELECT c.*, j.title job_title, cu.name client_name, tu.name talent_name, p.provider, p.reference, p.status payment_status
    FROM contracts c JOIN jobs j ON j.id=c.job_id JOIN users cu ON cu.id=c.client_id JOIN users tu ON tu.id=c.talent_id
    LEFT JOIN payments p ON p.id = (SELECT MAX(id) FROM payments WHERE contract_id=c.id AND status != 'void') ORDER BY c.updated_at DESC LIMIT 300`).all()
    .map(c => ({ ...c, state: require('../finance').moneyState(c, 'admin'), payout_blockers: c.status === 'released' ? require('../kyc').payoutBlockers(c) : [],
      needs: c.status === 'released' ? 'payout' : c.status === 'refunded' && !c.refunded_at ? 'refund' : c.status === 'disputed' ? 'dispute' : c.status === 'accepted' && c.payment_status === 'pending' && c.provider === 'manual' ? 'eft' : '' })) });
});
router.post('/contracts/:id/mark-funded', (req, res) => {
  const p = db.prepare("SELECT reference FROM payments WHERE contract_id = ? AND status = 'pending' ORDER BY id DESC").get(req.params.id);
  if (!p || !markFunded(Number(req.params.id), p.reference)) throw new HttpError(409, 'No pending payment to confirm');
  audit(req.user.id, 'payment.confirmed', req.params.id, p); res.json({ ok: true });
});
// Upfront escrow for remote jobs: EFT deposits to confirm, and unused balances to refund.
router.get('/finance', (_req, res) => res.json({ data: require('../finance').forAdmin() }));
router.get('/escrow', (_req, res) => {
  res.json({
    deposits: db.prepare(`SELECT d.*, j.title job_title, u.name client_name, u.email client_email FROM job_deposits d JOIN jobs j ON j.id = d.job_id JOIN users u ON u.id = d.client_id
      WHERE d.status = 'pending' OR d.created_at > datetime('now','-30 days') ORDER BY d.status = 'pending' DESC, d.id DESC LIMIT 200`).all(),
    refunds: db.prepare(`SELECT r.*, j.title job_title, u.name client_name, u.email client_email FROM escrow_refunds r JOIN jobs j ON j.id = r.job_id JOIN users u ON u.id = r.client_id
      ORDER BY r.status = 'due' DESC, r.id DESC LIMIT 200`).all(),
    held_cents: db.prepare('SELECT IFNULL(SUM(escrow_balance_cents),0) n FROM jobs WHERE escrow_required = 1').get().n,
  });
});
router.post('/escrow/deposits/:id/confirm', (req, res) => {
  const d = db.prepare("SELECT * FROM job_deposits WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!d) throw new HttpError(409, 'No pending escrow payment to confirm');
  require('../escrow').markDepositPaid(d.reference, 'eft-confirmed');
  audit(req.user.id, 'escrow.deposit_confirmed', d.job_id, { reference: d.reference, amount_cents: d.amount_cents }); res.json({ ok: true });
});
router.post('/escrow/refunds/:id/done', validate(z.object({ reference: z.string().trim().min(2).max(80) })), (req, res) => {
  const r = db.prepare("SELECT * FROM escrow_refunds WHERE id = ? AND status = 'due'").get(req.params.id);
  if (!r) throw new HttpError(409, 'No refund due');
  db.prepare("UPDATE escrow_refunds SET status = 'refunded', reference = ?, refunded_at = datetime('now') WHERE id = ?").run(req.body.reference, r.id);
  notify(r.client_id, 'payment', `Your escrow refund of R${(r.amount_cents / 100).toLocaleString('en-ZA')} has been paid back (reference ${req.body.reference}).`, `#job/${r.job_id}`, req.user.id);
  audit(req.user.id, 'escrow.refunded', r.job_id, { amount_cents: r.amount_cents, reference: req.body.reference }); res.json({ ok: true });
});
router.post('/contracts/:id/resolve', validate(z.object({ action: z.enum(['release', 'refund']), note: z.string().trim().max(500).default('') })), (req, res) => {
  const c = db.prepare("SELECT * FROM contracts WHERE id = ? AND status = 'disputed'").get(req.params.id);
  if (!c) throw new HttpError(409, 'Only disputed contracts can be resolved');
  const release = req.body.action === 'release';
  // A contract paid from a remote job's upfront escrow goes back to that job's balance; the client can reuse it or ask for it back.
  const pay = db.prepare("SELECT * FROM payments WHERE contract_id = ? AND status = 'paid' ORDER BY id DESC").get(c.id);
  const toJob = !release && pay?.provider === 'job_escrow';
  db.transaction(() => {
    if (release) db.prepare("UPDATE contracts SET status='released', released_at=datetime('now'), resolution=?, updated_at=datetime('now') WHERE id=?").run(req.body.note || 'Released after dispute', c.id);
    else db.prepare(`UPDATE contracts SET status='refunded', resolution=?, ${toJob ? "refunded_at=datetime('now'), refund_ref='Returned to job escrow'," : ''} updated_at=datetime('now') WHERE id=?`).run(req.body.note || 'Refunded after dispute', c.id);
    db.prepare("UPDATE payments SET status=? WHERE contract_id=? AND status='paid'").run(release ? 'payout_due' : toJob ? 'refunded' : 'refund_due', c.id);
    if (toJob) db.prepare('UPDATE jobs SET escrow_balance_cents = escrow_balance_cents + ? WHERE id = ?').run(c.amount_cents, c.job_id);
    if (release) db.prepare('UPDATE profiles SET jobs_done = jobs_done + 1 WHERE user_id = ?').run(c.talent_id);
    db.prepare("UPDATE reports SET status='resolved', admin_note=? WHERE target_type='contract' AND target_id=? AND status!='resolved'").run(req.body.note, c.id);
  })();
  const R = (x) => 'R' + (x / 100).toLocaleString('en-ZA');
  notify(c.client_id, 'dispute', `Dispute on contract #${c.id} resolved: ${release ? 'the payment was released to the professional' : toJob ? `${R(c.amount_cents)} went back into your job’s escrow` : `you will be refunded ${R(c.amount_cents)}`}.${req.body.note ? ' Note: ' + req.body.note : ''}`, `#contracts/${c.id}`);
  notify(c.talent_id, 'dispute', `Dispute on contract #${c.id} resolved: ${release ? `your payout of ${R(c.payout_cents)} is being processed` : 'the client was refunded'}.${req.body.note ? ' Note: ' + req.body.note : ''}`, `#contracts/${c.id}`);
  audit(req.user.id, `dispute.${req.body.action}`, c.id, { note: req.body.note }); res.json({ ok: true });
});
router.post('/contracts/:id/payout', validate(z.object({ payout_ref: z.string().trim().min(3).max(80) })), (req, res) => {
  const c = db.prepare("SELECT * FROM contracts WHERE id = ? AND status IN ('released','refunded')").get(req.params.id);
  if (!c) throw new HttpError(409, 'Nothing to pay out for this contract');
  if (c.status === 'released') { const blockers = require('../kyc').payoutBlockers(c); if (blockers.length) throw new HttpError(409, `Payout on hold: ${blockers.join('; ')}`); }
  if (c.status === 'refunded' && c.refunded_at) throw new HttpError(409, 'This refund was already recorded');
  db.transaction(() => {
    if (c.status === 'released') db.prepare("UPDATE contracts SET status='paid_out', payout_ref=?, paid_out_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(req.body.payout_ref, c.id);
    else db.prepare("UPDATE contracts SET refund_ref=?, refunded_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(req.body.payout_ref, c.id);
    db.prepare("UPDATE payments SET status = CASE WHEN status='payout_due' THEN 'paid_out' WHEN status='refund_due' THEN 'refunded' ELSE status END WHERE contract_id=?").run(c.id);
  })();
  const R = (x) => 'R' + (x / 100).toLocaleString('en-ZA');
  if (c.status === 'released') notify(c.talent_id, 'payment', `Payout of ${R(c.payout_cents)} for contract #${c.id} sent to your bank account (ref ${req.body.payout_ref}). It usually shows within 1 to 2 business days.`, `#payments`);
  else notify(c.client_id, 'payment', `Refund of ${R(c.amount_cents)} for contract #${c.id} sent (ref ${req.body.payout_ref}). It usually shows within 5 business days.`, `#payments`);
  audit(req.user.id, 'payout.recorded', c.id, { ref: req.body.payout_ref }); res.json({ ok: true });
});

router.get('/reports', (req, res) => {
  res.json({ data: db.prepare(`SELECT r.*, u.name reporter FROM reports r JOIN users u ON u.id=r.reporter_id ${req.query.status ? 'WHERE r.status = ?' : ''} ORDER BY r.id DESC LIMIT 200`).all(...(req.query.status ? [req.query.status] : [])) });
});
router.patch('/reports/:id', validate(z.object({ status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']), admin_note: z.string().max(500).default('') })), (req, res) => {
  db.prepare('UPDATE reports SET status=?, admin_note=? WHERE id=?').run(req.body.status, req.body.admin_note, req.params.id);
  audit(req.user.id, 'report.update', req.params.id, req.body); res.json({ ok: true });
});

router.get('/settings', (_req, res) => res.json({ commission_pct: setting('commission_pct', 10), vat_pct: setting('vat_pct', 15) }));
router.put('/settings', validate(z.object({ commission_pct: z.number().min(0).max(40), vat_pct: z.number().min(0).max(25) })), (req, res) => {
  const up = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  up.run('commission_pct', String(req.body.commission_pct)); up.run('vat_pct', String(req.body.vat_pct));
  audit(req.user.id, 'settings.update', '', req.body); res.json({ ok: true });
});

router.get('/audit', (_req, res) => {
  res.json({ data: db.prepare('SELECT a.*, u.name actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200').all() });
});

module.exports = router;
