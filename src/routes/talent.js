const router = require('express').Router();
const db = require('../db');
const { HttpError, validate, z, PROVINCES } = require('../util');
const { notify } = require('../services');
const { sendMail } = require('../mailer');

const shape = (r) => ({
  id: r.id, name: r.name, headline: r.headline, bio: r.bio, skills: JSON.parse(r.skills || '[]'),
  hourly_rate: r.hourly_rate, province: r.province, city: r.city, verified: !!r.verified,
  rating: r.rating, jobs_done: r.jobs_done, avatar_color: r.avatar_color,
  languages: r.languages || '', portfolio: JSON.parse(r.portfolio || '[]'), member_since: r.member_since,
  international: r.residency === 'foreign' && r.work_rights !== 'yes', country: r.residency === 'foreign' ? r.country || r.nationality || '' : '',
  relocate: !!r.relocate, occupation_ofo: r.occupation_ofo || '', occupation: require('../skills').byOfo(r.occupation_ofo)?.name || '',
  critical_skill: !!require('../skills').byOfo(r.occupation_ofo), experience_years: r.experience_years ?? null,
  saqa_status: r.saqa_status || '', prof_body: r.prof_body || '',
});
const BASE = `SELECT p.*, u.id, u.name, u.created_at AS member_since FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'talent' AND u.status = 'active'`;

router.get('/', validate(z.object({
  q: z.string().trim().max(80).optional(),
  province: z.enum(PROVINCES).optional(),
  verified: z.enum(['true', 'false']).optional(),
  sort: z.enum(['rating', 'jobs', 'rate_low', 'rate_high']).default('rating'),
  limit: z.coerce.number().int().min(1).max(50).default(24),
}), 'query'), (req, res) => {
  const { q, province, verified, limit, sort } = req.q;
  const where = [], args = [];
  if (province) { where.push('p.province = ?'); args.push(province); }
  if (verified === 'true') where.push('p.verified = 1');
  if (q) { where.push('(u.name LIKE ? OR p.headline LIKE ? OR p.skills LIKE ?)'); args.push(...Array(3).fill(`%${q}%`)); }
  const sql = `${BASE}${where.length ? ' AND ' + where.join(' AND ') : ''} ORDER BY ${{ rating: 'p.rating DESC, p.jobs_done DESC', jobs: 'p.jobs_done DESC', rate_low: 'p.hourly_rate ASC', rate_high: 'p.hourly_rate DESC' }[sort]} LIMIT ?`;
  res.json({ data: db.prepare(sql).all(...args, limit).map(shape) });
});

router.get('/:id', (req, res) => {
  const r = db.prepare(`${BASE} AND u.id = ?`).get(req.params.id);
  if (!r) throw new HttpError(404, 'Professional not found');
  const reviews = db.prepare(`SELECT rv.rating, rv.comment, rv.created_at, u.name AS client_name, j.title AS job_title FROM reviews rv
    JOIN users u ON u.id = rv.reviewer_id JOIN contracts c ON c.id = rv.contract_id JOIN jobs j ON j.id = c.job_id WHERE rv.talent_id = ? ORDER BY rv.id DESC LIMIT 20`).all(r.id);
  const quals = db.prepare("SELECT institution, qualification, field, year, status, verified_at FROM qualifications WHERE user_id = ? AND status IN ('verified','pending','in_progress') ORDER BY status = 'verified' DESC, year DESC").all(r.id)
    .map(q => ({ ...q, verified: q.status === 'verified' }));
  const k = db.prepare("SELECT u.kyc_status, (SELECT COUNT(*) FROM kyc_documents d WHERE d.user_id = u.id AND d.kind = 'proof_of_address' AND d.status = 'approved') AS addr, (SELECT COUNT(*) FROM kyc_documents d WHERE d.user_id = u.id AND d.kind = 'cv' AND d.status != 'replaced') AS cv FROM users u WHERE u.id = ?").get(r.id);
  res.json({ data: { ...shape(r), reviews, qualifications: quals, checks: { identity: k.kyc_status === 'approved', address: k.kyc_status === 'approved' && k.addr > 0, has_cv: k.cv > 0 } } });
});

router.post('/:id/hire-request', validate(z.object({
  from_name: z.string().trim().min(2).max(80),
  from_email: z.email(),
  message: z.string().trim().min(10).max(2000),
})), (req, res) => {
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'talent'").get(req.params.id)) throw new HttpError(404, 'Professional not found');
  const { from_name, from_email, message } = req.body;
  const id = db.prepare('INSERT INTO hire_requests (talent_id,from_name,from_email,message) VALUES (?,?,?,?)').run(req.params.id, from_name, from_email, message).lastInsertRowid;
  notify(req.params.id, 'lead', `${from_name} would like to hire you. TalentBridge will connect you shortly.`);
  sendMail(process.env.SUPPORT_EMAIL || 'support@talentbridge.co.za', 'New hire enquiry', `${from_name} <${from_email}> wants to hire talent #${req.params.id}:\n\n${message}`);
  res.status(201).json({ data: { id } });
});

// CV: visible to admins, the professional, and clients who have a bid, conversation or contract with them.
router.get('/:id/cv', require('../util').auth(), (req, res) => {
  const tid = Number(req.params.id), me = req.user;
  const ok = me.role === 'admin' || me.id === tid || (me.role === 'client' && (
    db.prepare('SELECT 1 FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? AND j.client_id = ?').get(tid, me.id)
    || db.prepare('SELECT 1 FROM conversations WHERE talent_id = ? AND client_id = ?').get(tid, me.id)));
  if (!ok) throw new HttpError(403, 'You can view a CV once this professional bids on your job or you start a conversation');
  const d = db.prepare("SELECT * FROM kyc_documents WHERE user_id = ? AND kind = 'cv' AND status != 'replaced' ORDER BY id DESC").get(tid);
  if (!d) throw new HttpError(404, 'No CV uploaded yet');
  require('../services').audit(me.id, 'cv.viewed', String(tid));
  require('./kyc').sendDoc(res, d);
});

// Signed-in client messages a professional directly (before any job or bid).
router.post('/:id/message', require('../util').auth(), require('../util').requireRole('client'), validate(z.object({ body: z.string().trim().min(1).max(2000) })), (req, res) => {
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'talent' AND status = 'active'").get(req.params.id)) throw new HttpError(404, 'Professional not found');
  const { getOrCreateConversation, postMessage } = require('../services');
  const conv = getOrCreateConversation(req.user.id, Number(req.params.id), null);
  postMessage(conv, req.user.id, req.body.body);
  res.status(201).json({ data: { conversation_id: conv.id } });
});

module.exports = router;
