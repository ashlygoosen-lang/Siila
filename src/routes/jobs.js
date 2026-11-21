const router = require('express').Router();
const db = require('../db');
const { requireEmailVerified, HttpError, auth, requireRole, validate, payLabel, z, PROVINCES, CATEGORIES, TYPES } = require('../util');
const { notify, getOrCreateConversation, postMessage } = require('../services');
const { emit } = require('../events');

const bidStats = db.prepare('SELECT COUNT(*) n, ROUND(AVG(bid_amount)) avg FROM applications WHERE job_id = ?');
const clientInfo = db.prepare(`SELECT u.name, u.created_at, u.email_verified,
  (SELECT COUNT(*) FROM jobs WHERE client_id = u.id) jobs_posted,
  (SELECT COUNT(*) FROM contracts WHERE client_id = u.id AND status IN ('released','paid_out')) hires
  FROM users u WHERE u.id = ?`);

const shape = (j, saved = false) => ({
  id: j.id, title: j.title, description: j.description, category: j.category, type: j.type,
  province: j.province, city: j.city, location: `${j.city}, ${j.province}`,
  pay_min: j.pay_min, pay_max: j.pay_max, pay_unit: j.pay_unit, pay_label: payLabel(j),
  icon: j.icon, gradient: j.gradient, featured: !!j.featured, status: j.status, created_at: j.created_at, saved,
  client_id: j.client_id, bids: bidStats.get(j.id).n, avg_bid: bidStats.get(j.id).avg || null,
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
  const out = shape(j, saved);
  out.client = clientInfo.get(j.client_id) || null;
  if (req.user?.role === 'talent') out.my_bid = db.prepare('SELECT id, bid_amount, delivery_days, message, status, created_at FROM applications WHERE job_id = ? AND user_id = ?').get(j.id, req.user.id) || null;
  res.json({ data: out });
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
  const job = shape(db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  // Alert freelancers whose skills or headline match the job (like a project feed), capped to stay polite.
  const words = `${j.title} ${j.category}`.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
  if (words.length) {
    const like = words.map(() => '(LOWER(p.skills) LIKE ? OR LOWER(p.headline) LIKE ?)').join(' OR ');
    const matches = db.prepare(`SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'talent' AND u.status = 'active' AND (${like}) LIMIT 50`)
      .all(...words.flatMap(w => [`%${w}%`, `%${w}%`]));
    for (const m of matches) notify(m.id, 'job_match', `New job that matches your skills: "${j.title}" in ${j.city}.`, `#job/${id}`, req.user.id);
  }
  res.status(201).json({ data: job });
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

const bidBody = z.object({
  message: z.string().trim().max(3000).default(''),
  bid_amount: z.number().int().min(50).max(1000000).optional(),
  delivery_days: z.number().int().min(1).max(365).optional(),
});

// Talent places a bid (price + delivery time + proposal). A plain application without a price still works.
router.post('/:id/apply', auth(), requireRole('talent'), requireEmailVerified, validate(bidBody), (req, res) => {
  const j = db.prepare("SELECT * FROM jobs WHERE id = ? AND status = 'open'").get(req.params.id);
  if (!j) throw new HttpError(404, 'This job is not open');
  const { message, bid_amount, delivery_days } = req.body;
  let id;
  try {
    id = db.prepare("INSERT INTO applications (job_id,user_id,message,bid_amount,delivery_days,updated_at) VALUES (?,?,?,?,?,datetime('now'))")
      .run(j.id, req.user.id, message, bid_amount ?? null, delivery_days ?? null).lastInsertRowid;
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'You have already applied to this job');
    throw e;
  }
  const me = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id).name;
  const price = bid_amount ? ` R${bid_amount.toLocaleString('en-ZA')}${delivery_days ? ` in ${delivery_days} day${delivery_days > 1 ? 's' : ''}` : ''}` : '';
  notify(j.client_id, 'bid', `${me} bid${price} on "${j.title}".`, `#job/${j.id}/bids`, req.user.id);
  emit(j.client_id, 'bids', { job_id: j.id });
  res.status(201).json({ data: { id, job_id: j.id, status: 'submitted', bid_amount: bid_amount ?? null, delivery_days: delivery_days ?? null } });
});

// Edit a bid that has not been decided yet.
router.put('/:id/apply', auth(), requireRole('talent'), validate(bidBody), (req, res) => {
  const a = db.prepare('SELECT a.*, j.client_id, j.title FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.job_id = ? AND a.user_id = ?').get(req.params.id, req.user.id);
  if (!a) throw new HttpError(404, 'You have not bid on this job');
  if (!['submitted', 'shortlisted'].includes(a.status)) throw new HttpError(409, 'This bid can no longer be changed');
  db.prepare("UPDATE applications SET message = ?, bid_amount = ?, delivery_days = ?, updated_at = datetime('now') WHERE id = ?")
    .run(req.body.message, req.body.bid_amount ?? null, req.body.delivery_days ?? null, a.id);
  emit(a.client_id, 'bids', { job_id: a.job_id });
  res.json({ ok: true });
});

// Withdraw a bid.
router.delete('/:id/apply', auth(), requireRole('talent'), (req, res) => {
  const a = db.prepare('SELECT a.*, j.client_id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.job_id = ? AND a.user_id = ?').get(req.params.id, req.user.id);
  if (!a) throw new HttpError(404, 'You have not bid on this job');
  if (a.status === 'hired') throw new HttpError(409, 'You were already hired for this job');
  db.prepare('DELETE FROM applications WHERE id = ?').run(a.id);
  emit(a.client_id, 'bids', { job_id: a.job_id });
  res.status(204).end();
});

router.get('/:id/applications', auth(), (req, res) => {
  owned(req);
  const sort = { price: 'a.bid_amount IS NULL, a.bid_amount ASC', rating: 'p.rating DESC', fast: 'a.delivery_days IS NULL, a.delivery_days ASC' }[req.query.sort] || 'a.created_at DESC';
  const rows = db.prepare(`SELECT a.id, a.status, a.message, a.bid_amount, a.delivery_days, a.created_at, a.updated_at,
      u.id AS talent_id, u.name, p.headline, p.rating, p.verified, p.jobs_done, p.skills, p.province, p.city, p.avatar_color,
      (SELECT id FROM conversations WHERE client_id = ? AND talent_id = u.id AND IFNULL(job_id,0) = a.job_id) AS conversation_id
    FROM applications a JOIN users u ON u.id = a.user_id LEFT JOIN profiles p ON p.user_id = u.id WHERE a.job_id = ? ORDER BY ${sort}`).all(req.user.id, req.params.id);
  res.json({ data: rows.map(r => ({ ...r, verified: !!r.verified, skills: JSON.parse(r.skills || '[]') })) });
});

// Client shortlists or rejects a bid; the professional is told live.
router.patch('/:id/applications/:aid', auth(), validate(z.object({ status: z.enum(['submitted', 'shortlisted', 'rejected']) })), (req, res) => {
  const j = owned(req);
  const a = db.prepare('SELECT * FROM applications WHERE id = ? AND job_id = ?').get(req.params.aid, j.id);
  if (!a) throw new HttpError(404, 'Bid not found');
  if (a.status === 'hired') throw new HttpError(409, 'This professional is already hired');
  db.prepare("UPDATE applications SET status = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.status, a.id);
  if (req.body.status === 'shortlisted') notify(a.user_id, 'shortlisted', `Your bid on "${j.title}" was shortlisted.`, `#job/${j.id}`, req.user.id);
  if (req.body.status === 'rejected') notify(a.user_id, 'bid_rejected', `Your bid on "${j.title}" was not selected this time.`, `#job/${j.id}`, req.user.id);
  res.json({ ok: true });
});

// Client opens a chat with a bidder (like "Chat" on a bid).
router.post('/:id/applications/:aid/chat', auth(), validate(z.object({ body: z.string().trim().max(2000).default('') })), (req, res) => {
  const j = owned(req);
  const a = db.prepare('SELECT * FROM applications WHERE id = ? AND job_id = ?').get(req.params.aid, j.id);
  if (!a) throw new HttpError(404, 'Bid not found');
  const conv = getOrCreateConversation(j.client_id, a.user_id, j.id);
  if (req.body.body) postMessage(conv, req.user.id, req.body.body);
  res.status(201).json({ data: { conversation_id: conv.id } });
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
