const router = require('express').Router();
const db = require('../db');
const { requireEmailVerified, HttpError, auth, requireRole, validate, payLabel, z, PROVINCES, CATEGORIES, TYPES } = require('../util');

const shape = (j, saved = false) => ({
  id: j.id, title: j.title, description: j.description, category: j.category, type: j.type,
  province: j.province, city: j.city, location: `${j.city}, ${j.province}`,
  pay_min: j.pay_min, pay_max: j.pay_max, pay_unit: j.pay_unit, pay_label: payLabel(j),
  icon: j.icon, gradient: j.gradient, featured: !!j.featured, status: j.status, created_at: j.created_at, saved,
});

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  type: z.enum(TYPES).optional(),
  category: z.enum(CATEGORIES).optional(),
  province: z.enum(PROVINCES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

router.get('/', auth(false), validate(listQuery, 'query'), (req, res) => {
  const { q, type, category, province, page, limit } = req.q;
  const where = ["status = 'open'"], args = [];
  if (type) { where.push('type = ?'); args.push(type); }
  if (category) { where.push('category = ?'); args.push(category); }
  if (province) { where.push('province = ?'); args.push(province); }
  if (q) { where.push('(title LIKE ? OR description LIKE ? OR category LIKE ?)'); args.push(...Array(3).fill(`%${q}%`)); }
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM jobs WHERE ${w} ORDER BY featured DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
  const savedIds = new Set(req.user ? db.prepare('SELECT job_id FROM saved_jobs WHERE user_id = ?').all(req.user.id).map(r => r.job_id) : []);
  res.json({ data: rows.map(j => shape(j, savedIds.has(j.id))), meta: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get('/:id', auth(false), (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!j) throw new HttpError(404, 'Job not found');
  const saved = req.user ? !!db.prepare('SELECT 1 FROM saved_jobs WHERE user_id=? AND job_id=?').get(req.user.id, j.id) : false;
  res.json({ data: shape(j, saved) });
});

const jobBody = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(5000),
  category: z.enum(CATEGORIES),
  type: z.enum(TYPES),
  province: z.enum(PROVINCES),
  city: z.string().trim().min(2).max(80),
  pay_min: z.number().int().min(0),
  pay_max: z.number().int().min(0),
  pay_unit: z.enum(['hour', 'day', 'month', 'project']),
  icon: z.string().max(20).default('brief'),
}).refine(j => j.pay_max >= j.pay_min, { message: 'pay_max must be at least pay_min', path: ['pay_max'] });

router.post('/', auth(), requireRole('client', 'admin'), requireEmailVerified, validate(jobBody), (req, res) => {
  const j = req.body;
  const id = db.prepare(`INSERT INTO jobs (client_id,title,description,category,type,province,city,pay_min,pay_max,pay_unit,icon)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, j.title, j.description, j.category, j.type, j.province, j.city, j.pay_min, j.pay_max, j.pay_unit, j.icon).lastInsertRowid;
  res.status(201).json({ data: shape(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)) });
});

const owned = (req) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!j) throw new HttpError(404, 'Job not found');
  if (j.client_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'This job belongs to another account');
  return j;
};

router.patch('/:id', auth(), validate(z.object({ status: z.enum(['open', 'closed']) })), (req, res) => {
  owned(req);
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ data: shape(db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id)) });
});

router.delete('/:id', auth(), (req, res) => {
  owned(req);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

router.post('/:id/apply', auth(), requireRole('talent'), requireEmailVerified, validate(z.object({ message: z.string().trim().max(2000).default('') })), (req, res) => {
  const j = db.prepare("SELECT id FROM jobs WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!j) throw new HttpError(404, 'This job is not open');
  try {
    const id = db.prepare('INSERT INTO applications (job_id,user_id,message) VALUES (?,?,?)').run(j.id, req.user.id, req.body.message).lastInsertRowid;
    res.status(201).json({ data: { id, job_id: j.id, status: 'submitted' } });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'You have already applied to this job');
    throw e;
  }
});

router.get('/:id/applications', auth(), (req, res) => {
  owned(req);
  const rows = db.prepare(`SELECT a.id, a.status, a.message, a.created_at, u.id AS talent_id, u.name, p.headline, p.rating, p.verified
    FROM applications a JOIN users u ON u.id = a.user_id LEFT JOIN profiles p ON p.user_id = u.id WHERE a.job_id = ? ORDER BY a.created_at DESC`).all(req.params.id);
  res.json({ data: rows });
});

router.post('/:id/save', auth(), (req, res) => {
  if (!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(req.params.id)) throw new HttpError(404, 'Job not found');
  db.prepare('INSERT OR IGNORE INTO saved_jobs (user_id,job_id) VALUES (?,?)').run(req.user.id, req.params.id);
  res.status(204).end();
});
router.delete('/:id/save', auth(), (req, res) => {
  db.prepare('DELETE FROM saved_jobs WHERE user_id=? AND job_id=?').run(req.user.id, req.params.id);
  res.status(204).end();
});

module.exports = router;
module.exports.shape = shape;
