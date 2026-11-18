const router = require('express').Router();
const db = require('../db');
const { auth, requireRole, validate, z, PROVINCES } = require('../util');
const { shape } = require('./jobs');

router.use(auth());

router.get('/saved', (req, res) => {
  const rows = db.prepare('SELECT j.* FROM jobs j JOIN saved_jobs s ON s.job_id = j.id WHERE s.user_id = ? ORDER BY j.created_at DESC').all(req.user.id);
  res.json({ data: rows.map(j => shape(j, true)) });
});

router.get('/applications', requireRole('talent'), (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.status, a.created_at, j.id AS job_id, j.title, j.city, j.province
    FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? ORDER BY a.created_at DESC`).all(req.user.id);
  res.json({ data: rows });
});

router.get('/jobs', requireRole('client', 'admin'), (req, res) => {
  const rows = db.prepare(`SELECT j.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS applicants
    FROM jobs j WHERE j.client_id = ? ORDER BY j.created_at DESC`).all(req.user.id);
  res.json({ data: rows.map(j => ({ ...shape(j), applicants: j.applicants })) });
});

router.put('/profile', requireRole('talent'), validate(z.object({
  headline: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(2000).optional(),
  skills: z.array(z.string().trim().min(1).max(30)).max(15).optional(),
  hourly_rate: z.number().int().min(0).max(100000).optional(),
  province: z.enum(PROVINCES).optional(),
  city: z.string().trim().max(80).optional(),
})), (req, res) => {
  const b = req.body;
  const sets = [], args = [];
  for (const k of ['headline', 'bio', 'hourly_rate', 'province', 'city']) if (b[k] !== undefined) { sets.push(`${k} = ?`); args.push(b[k]); }
  if (b.skills) { sets.push('skills = ?'); args.push(JSON.stringify(b.skills)); }
  if (sets.length) db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = ?`).run(...args, req.user.id);
  res.json({ data: db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id) });
});

module.exports = router;
