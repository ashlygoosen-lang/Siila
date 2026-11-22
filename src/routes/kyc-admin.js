// Admin review of identity verification, qualification checks with institutions, and fraud/AML flags.
const router = require('express').Router();
const db = require('../db');
const { HttpError, auth, requireRole, validate, z } = require('../util');
const { notify, audit } = require('../services');
const { decryptText } = require('../vault');
const K = require('../kyc');
const { sendDoc } = require('./kyc');

router.use(auth(), requireRole('admin'));

const openFlags = (uid) => db.prepare("SELECT * FROM risk_flags WHERE user_id = ? ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC").all(uid);

router.get('/kyc', validate(z.object({ status: z.enum(['pending', 'needs_info', 'approved', 'rejected', 'draft', 'all']).default('pending') }), 'query'), (req, res) => {
  const st = req.q.status;
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.kyc_status, k.legal_name, k.account_type, k.id_type, k.submitted_at, k.is_pep,
      (SELECT COUNT(*) FROM risk_flags f WHERE f.user_id = u.id AND f.status = 'open' AND f.severity = 'high') AS high_flags,
      (SELECT COUNT(*) FROM risk_flags f WHERE f.user_id = u.id AND f.status = 'open') AS open_flags,
      (SELECT COUNT(*) FROM qualifications q WHERE q.user_id = u.id AND q.status IN ('pending','in_progress')) AS quals_pending
    FROM users u LEFT JOIN kyc_profiles k ON k.user_id = u.id
    WHERE u.role IN ('talent','client') ${st === 'all' ? "AND u.kyc_status != 'none'" : 'AND u.kyc_status = ?'}
    ORDER BY high_flags DESC, k.submitted_at ASC LIMIT 300`).all(...(st === 'all' ? [] : [st]));
  res.json({ data: rows.map(r => ({ ...r, is_pep: !!r.is_pep })) });
});

router.get('/kyc/:uid', (req, res) => {
  const s = K.state(req.params.uid);
  if (!s.user) throw new HttpError(404, 'Member not found');
  const k = s.kyc;
  const bank = db.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').get(req.params.uid);
  audit(req.user.id, 'kyc.viewed', req.params.uid);
  res.json({ data: {
    user: { ...s.user, email: db.prepare('SELECT email, created_at FROM users WHERE id = ?').get(req.params.uid) },
    status: s.status, requirements: s.requirements, complete: s.complete,
    details: k ? { ...k, id_number: k.id_number_enc ? decryptText(k.id_number_enc) : '', id_number_enc: undefined, id_number_hash: undefined,
      sa_id_check: k.id_type === 'sa_id' && k.id_number_enc ? K.parseSaId(decryptText(k.id_number_enc)) : null, age: k.dob ? K.ageOn(k.dob) : null } : null,
    docs: s.docs, qualifications: db.prepare('SELECT * FROM qualifications WHERE user_id = ? ORDER BY id').all(req.params.uid),
    bank: bank ? { holder: bank.holder, bank: bank.bank, account_number: decryptText(bank.account_enc), branch_code: bank.branch_code, account_type: bank.account_type, changed_at: bank.changed_at,
      holder_matches: k ? (K.namesMatch(bank.holder, k.legal_name) || K.namesMatch(bank.holder, k.business_name)) : null } : null,
    flags: openFlags(req.params.uid),
    history: db.prepare("SELECT a.action, a.created_at, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.target = ? AND a.action LIKE 'kyc.%' ORDER BY a.id DESC LIMIT 30").all(String(req.params.uid)),
  } });
});

router.get('/kyc/documents/:id/file', (req, res) => {
  const d = db.prepare('SELECT * FROM kyc_documents WHERE id = ?').get(req.params.id);
  if (!d) throw new HttpError(404, 'Document not found');
  audit(req.user.id, 'kyc.document_viewed', String(d.user_id), { document: d.id, kind: d.kind });
  sendDoc(res, d);
});

router.post('/kyc/documents/:id/decision', validate(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).default('') })), (req, res) => {
  const d = db.prepare("SELECT * FROM kyc_documents WHERE id = ? AND status != 'replaced'").get(req.params.id);
  if (!d) throw new HttpError(404, 'Document not found');
  if (req.body.decision === 'rejected' && req.body.note.length < 5) throw new HttpError(400, 'Tell the member why the document was rejected');
  db.prepare("UPDATE kyc_documents SET status = ?, note = ?, reviewed_at = datetime('now'), reviewer_id = ? WHERE id = ?").run(req.body.decision, req.body.note, req.user.id, d.id);
  audit(req.user.id, `kyc.document_${req.body.decision}`, String(d.user_id), { document: d.id, kind: d.kind });
  res.json({ ok: true });
});

// Overall decision. Approval requires every required document to be approved and no open high-risk flags.
router.post('/kyc/:uid/decision', validate(z.object({ decision: z.enum(['approved', 'needs_info', 'rejected']), note: z.string().trim().max(1000).default('') })), (req, res) => {
  const uid = Number(req.params.uid), { decision, note } = req.body;
  const s = K.state(uid);
  if (!s.user) throw new HttpError(404, 'Member not found');
  if (!['pending', 'needs_info', 'approved', 'rejected'].includes(s.status)) throw new HttpError(409, 'This member has not submitted verification');
  if (decision !== 'approved' && note.length < 5) throw new HttpError(400, 'Explain what the member must fix');
  if (decision === 'approved') {
    const req2 = s.requirements.filter(r => r.doc && !r.optional);
    const notApproved = req2.filter(r => !s.docs.some(d => d.kind === r.key && d.status === 'approved')).map(r => r.label);
    if (s.docs.some(d => d.kind === 'id_back' && d.status === 'pending')) notApproved.push('ID document (back)');
    if (notApproved.length) throw new HttpError(409, `Approve these documents first: ${notApproved.join(', ')}`);
    const high = db.prepare("SELECT kind FROM risk_flags WHERE user_id = ? AND status = 'open' AND severity = 'high'").all(uid);
    if (high.length) throw new HttpError(409, `Resolve the high-risk flags first: ${[...new Set(high.map(f => f.kind))].join(', ')}`);
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET kyc_status = ? WHERE id = ?').run(decision, uid);
    db.prepare("UPDATE kyc_profiles SET reviewed_at = datetime('now'), reviewer_id = ?, review_note = ? WHERE user_id = ?").run(req.user.id, note, uid);
    db.prepare('UPDATE profiles SET verified = ? WHERE user_id = ?').run(decision === 'approved' ? 1 : 0, uid);
  })();
  audit(req.user.id, `kyc.${decision}`, String(uid), { note });
  notify(uid, 'verification', decision === 'approved' ? 'Your identity is verified. Your verified badge now shows on your profile.'
    : decision === 'needs_info' ? `We need a little more for your verification: ${note}` : `Your verification was not approved: ${note}`, '#verify', req.user.id);
  res.json({ ok: true });
});

// Record how a qualification was confirmed with the issuing institution (or SAQA).
router.post('/qualifications/:id/verify', validate(z.object({
  outcome: z.enum(['in_progress', 'verified', 'rejected', 'unverifiable']),
  method: z.enum(['institution_email', 'institution_phone', 'institution_portal', 'saqa', 'third_party', 'other']),
  contact: z.string().trim().min(3).max(200), reference: z.string().trim().max(120).default(''), note: z.string().trim().max(1000).default(''),
})), (req, res) => {
  const q = db.prepare('SELECT * FROM qualifications WHERE id = ?').get(req.params.id);
  if (!q) throw new HttpError(404, 'Qualification not found');
  const b = req.body;
  if (b.outcome === 'verified' && !b.reference) throw new HttpError(400, 'Record the institution’s confirmation reference (for example an email date, letter or SAQA reference)');
  db.prepare(`UPDATE qualifications SET status = ?, verify_method = ?, verify_contact = ?, verify_reference = ?, verify_note = ?, verified_at = CASE WHEN ? = 'verified' THEN datetime('now') ELSE verified_at END, verifier_id = ? WHERE id = ?`)
    .run(b.outcome, b.method, b.contact, b.reference, b.note, b.outcome, req.user.id, q.id);
  audit(req.user.id, `kyc.qualification_${b.outcome}`, String(q.user_id), { qualification: q.id, method: b.method, reference: b.reference });
  if (b.outcome === 'verified') notify(q.user_id, 'verification', `Your ${q.qualification} from ${q.institution} was confirmed with the institution and now shows as verified.`, '#verify', req.user.id);
  if (b.outcome === 'rejected') { notify(q.user_id, 'verification', `${q.institution} could not confirm your ${q.qualification}. ${b.note}`, '#verify', req.user.id); K.flag(q.user_id, 'qualification_rejected', 'high', `${q.institution} did not confirm "${q.qualification}"`); }
  res.json({ ok: true });
});

router.get('/risk-flags', validate(z.object({ status: z.enum(['open', 'cleared', 'confirmed', 'all']).default('open') }), 'query'), (req, res) => {
  const st = req.q.status;
  res.json({ data: db.prepare(`SELECT f.*, u.name, u.email, u.role FROM risk_flags f LEFT JOIN users u ON u.id = f.user_id ${st === 'all' ? '' : 'WHERE f.status = ?'}
    ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END, CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, f.id DESC LIMIT 300`).all(...(st === 'all' ? [] : [st])) });
});
router.post('/risk-flags/:id/resolve', validate(z.object({ outcome: z.enum(['cleared', 'confirmed']), note: z.string().trim().min(5).max(500) })), (req, res) => {
  const f = db.prepare('SELECT * FROM risk_flags WHERE id = ?').get(req.params.id);
  if (!f) throw new HttpError(404, 'Flag not found');
  db.transaction(() => {
    db.prepare("UPDATE risk_flags SET status = ?, note = ?, resolved_at = datetime('now'), resolver_id = ? WHERE id = ?").run(req.body.outcome, req.body.note, req.user.id, f.id);
    if (f.kind === 'high_value' && f.contract_id && req.body.outcome === 'cleared') db.prepare('UPDATE contracts SET aml_hold = 0 WHERE id = ?').run(f.contract_id);
    if (req.body.outcome === 'confirmed' && f.severity === 'high' && f.user_id) db.prepare("UPDATE users SET status = 'suspended' WHERE id = ? AND role != 'admin'").run(f.user_id);
  })();
  audit(req.user.id, `risk.${req.body.outcome}`, String(f.user_id || ''), { flag: f.id, kind: f.kind, note: req.body.note });
  res.json({ ok: true });
});

module.exports = router;
