const router = require('express').Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { HttpError, auth, requireRole, validate, z, PROVINCES } = require('../util');
const { notify } = require('../services');
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


const n = (sql, ...a) => db.prepare(sql).get(...a).n || 0;

router.get('/overview', (req, res) => {
  const id = req.user.id;
  if (req.user.role === 'talent') {
    const p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id) || {};
    const done = [p.headline, p.bio, JSON.parse(p.skills || '[]').length, p.hourly_rate, p.province, p.city].filter(Boolean).length;
    return res.json({
      role: 'talent', verified: !!p.verified, rating: p.rating, jobs_done: p.jobs_done, profile_pct: Math.round(done / 6 * 100),
      applications: n('SELECT COUNT(*) n FROM applications WHERE user_id = ?', id),
      active_contracts: n("SELECT COUNT(*) n FROM contracts WHERE talent_id = ? AND status IN ('offered','accepted','funded','delivered')", id),
      earned_cents: n("SELECT SUM(payout_cents) n FROM contracts WHERE talent_id = ? AND status = 'paid_out'", id),
      pending_cents: n("SELECT SUM(payout_cents) n FROM contracts WHERE talent_id = ? AND status IN ('funded','delivered','released')", id),
      verification: db.prepare('SELECT status FROM verifications WHERE user_id = ? ORDER BY id DESC').get(id)?.status || null,
    });
  }
  res.json({
    role: req.user.role,
    open_jobs: n("SELECT COUNT(*) n FROM jobs WHERE client_id = ? AND status = 'open'", id),
    applicants: n('SELECT COUNT(*) n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.client_id = ?', id),
    active_contracts: n("SELECT COUNT(*) n FROM contracts WHERE client_id = ? AND status IN ('offered','accepted','funded','delivered')", id),
    needs_action: n("SELECT COUNT(*) n FROM contracts WHERE client_id = ? AND status IN ('accepted','delivered')", id),
    spent_cents: n("SELECT SUM(amount_cents) n FROM contracts WHERE client_id = ? AND status IN ('funded','delivered','released','paid_out')", id),
  });
});

router.get('/notifications', (req, res) => {
  res.json({ data: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id), unread: n('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', req.user.id) });
});
router.post('/notifications/read', (req, res) => { db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id); res.status(204).end(); });

router.post('/verification', requireRole('talent', 'client'), validate(z.object({
  id_type: z.enum(['SA ID', 'Passport', 'Trade certificate', 'Company (CIPC)']),
  reference: z.string().trim().min(4).max(40), note: z.string().trim().max(500).default(''),
})), (req, res) => {
  if (db.prepare("SELECT 1 FROM verifications WHERE user_id = ? AND status = 'pending'").get(req.user.id)) throw new HttpError(409, 'You already have a request under review');
  // POPIA data minimisation: only the last 4 characters of the document number are stored.
  db.prepare('INSERT INTO verifications (user_id,id_type,ref_last4,note) VALUES (?,?,?,?)').run(req.user.id, req.body.id_type, req.body.reference.slice(-4), req.body.note);
  res.status(201).json({ ok: true });
});

router.post('/report', validate(z.object({ target_type: z.enum(['job', 'user', 'contract']), target_id: z.number().int(), reason: z.string().trim().min(10).max(1000) })), (req, res) => {
  db.prepare('INSERT INTO reports (reporter_id,target_type,target_id,reason) VALUES (?,?,?,?)').run(req.user.id, req.body.target_type, req.body.target_id, req.body.reason);
  res.status(201).json({ ok: true });
});

// POPIA: right of access
router.get('/export', (req, res) => {
  const id = req.user.id, all = (sql) => db.prepare(sql).all(id);
  res.setHeader('Content-Disposition', 'attachment; filename="siira-my-data.json"');
  res.json({
    exported_at: new Date().toISOString(),
    account: db.prepare('SELECT id,name,email,phone,role,status,consent_at,created_at FROM users WHERE id = ?').get(id),
    profile: db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id) || null,
    jobs: all('SELECT * FROM jobs WHERE client_id = ?'), applications: all('SELECT * FROM applications WHERE user_id = ?'),
    contracts: all('SELECT * FROM contracts WHERE client_id = ? OR talent_id = ?'.replace('talent_id = ?', 'talent_id = ' + id)),
    messages: all('SELECT * FROM messages WHERE sender_id = ?'), notifications: all('SELECT * FROM notifications WHERE user_id = ?'),
  });
});

// POPIA: right to deletion. Financial records are kept (tax law) but the person is anonymised.
router.post('/delete', validate(z.object({ password: z.string().min(1) })), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (u.role === 'admin') throw new HttpError(403, 'Admin accounts cannot be self-deleted');
  if (!bcrypt.compareSync(req.body.password, u.password_hash)) throw new HttpError(401, 'Incorrect password');
  if (n("SELECT COUNT(*) n FROM contracts WHERE (client_id = ? OR talent_id = ?) AND status IN ('offered','accepted','funded','delivered','disputed','released')", u.id, u.id)) throw new HttpError(409, 'Finish or cancel your active contracts first');
  db.transaction(() => {
    db.prepare("UPDATE users SET name='Deleted user', email=?, phone='', status='deleted', password_hash=? WHERE id=?").run(`deleted+${u.id}@siira.invalid`, bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 4), u.id);
    db.prepare("UPDATE profiles SET headline='', bio='', skills='[]', city='', verified=0 WHERE user_id=?").run(u.id);
    db.prepare("UPDATE jobs SET status='closed' WHERE client_id=?").run(u.id);
    db.prepare('DELETE FROM saved_jobs WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM notifications WHERE user_id=?').run(u.id);
  })();
  res.status(204).end();
});

module.exports = router;
