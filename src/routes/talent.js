const router = require('express').Router();
const db = require('../db');
const { HttpError, validate, z, PROVINCES } = require('../util');
const { notify } = require('../services');
const { sendMail } = require('../mailer');

const shape = (r) => ({
  id: r.id, name: r.name, headline: r.headline, bio: r.bio, skills: JSON.parse(r.skills || '[]'),
  hourly_rate: r.hourly_rate, province: r.province, city: r.city, verified: !!r.verified,
  rating: r.rating, jobs_done: r.jobs_done, avatar_color: r.avatar_color,
});
const BASE = `SELECT u.id, u.name, p.* FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'talent'`;

router.get('/', validate(z.object({
  q: z.string().trim().max(80).optional(),
  province: z.enum(PROVINCES).optional(),
  verified: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
}), 'query'), (req, res) => {
  const { q, province, verified, limit } = req.q;
  const where = [], args = [];
  if (province) { where.push('p.province = ?'); args.push(province); }
  if (verified === 'true') where.push('p.verified = 1');
  if (q) { where.push('(u.name LIKE ? OR p.headline LIKE ? OR p.skills LIKE ?)'); args.push(...Array(3).fill(`%${q}%`)); }
  const sql = `${BASE}${where.length ? ' AND ' + where.join(' AND ') : ''} ORDER BY p.rating DESC, p.jobs_done DESC LIMIT ?`;
  res.json({ data: db.prepare(sql).all(...args, limit).map(shape) });
});

router.get('/:id', (req, res) => {
  const r = db.prepare(`${BASE} AND u.id = ?`).get(req.params.id);
  if (!r) throw new HttpError(404, 'Professional not found');
  res.json({ data: shape(r) });
});

router.post('/:id/hire-request', validate(z.object({
  from_name: z.string().trim().min(2).max(80),
  from_email: z.email(),
  message: z.string().trim().min(10).max(2000),
})), (req, res) => {
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'talent'").get(req.params.id)) throw new HttpError(404, 'Professional not found');
  const { from_name, from_email, message } = req.body;
  const id = db.prepare('INSERT INTO hire_requests (talent_id,from_name,from_email,message) VALUES (?,?,?,?)').run(req.params.id, from_name, from_email, message).lastInsertRowid;
  notify(req.params.id, 'lead', `${from_name} would like to hire you. SIIRA will connect you shortly.`);
  sendMail(process.env.SUPPORT_EMAIL, 'New hire enquiry', `${from_name} <${from_email}> wants to hire talent #${req.params.id}:\n\n${message}`);
  res.status(201).json({ data: { id } });
});

module.exports = router;
