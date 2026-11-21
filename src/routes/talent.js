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
  res.json({ data: { ...shape(r), reviews } });
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
  sendMail(process.env.SUPPORT_EMAIL, 'New hire enquiry', `${from_name} <${from_email}> wants to hire talent #${req.params.id}:\n\n${message}`);
  res.status(201).json({ data: { id } });
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
