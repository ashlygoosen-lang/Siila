const router = require('express').Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { HttpError, auth, requireRole, validate, z, PROVINCES } = require('../util');
const fs = require('fs');
const multer = require('multer');
const { UPLOAD_DIR, counts } = require('../services');
const { subscribe, send, emit } = require('../events');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
const MAGIC = { 'application/pdf': '25504446', 'image/jpeg': 'ffd8ff', 'image/png': '89504e47' };
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (_q, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (EXT[f.mimetype] || '')) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_q, f, cb) => EXT[f.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Upload a PDF, JPG or PNG file')),
});
function realType(file) { // check the file's first bytes match what it claims to be
  const b = Buffer.alloc(4), fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
  return b.toString('hex').startsWith(MAGIC[file.mimetype]);
}
const { shape } = require('./jobs');

router.use(auth());

router.get('/saved', (req, res) => {
  const rows = db.prepare('SELECT j.* FROM jobs j JOIN saved_jobs s ON s.job_id = j.id WHERE s.user_id = ? ORDER BY j.created_at DESC').all(req.user.id);
  res.json({ data: rows.map(j => shape(j, true)) });
});

router.get('/applications', requireRole('talent'), (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.status, a.created_at, a.updated_at, a.message, a.bid_amount, a.delivery_days,
      j.id AS job_id, j.title, j.city, j.province, j.status AS job_status, j.pay_label_unit, j.client_id,
      (SELECT COUNT(*) FROM applications x WHERE x.job_id = j.id) AS bids,
      (SELECT id FROM conversations c WHERE c.talent_id = a.user_id AND c.client_id = j.client_id AND IFNULL(c.job_id,0) = j.id) AS conversation_id
    FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? ORDER BY a.created_at DESC`.replace('j.pay_label_unit, ', '')).all(req.user.id);
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
  skills: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  residency: z.enum(['citizen', 'permanent_resident', 'foreign']).optional(),
  work_rights: z.enum(['yes', 'needs_sponsorship']).optional(),
  country: z.string().trim().max(60).optional(),
  nationality: z.string().trim().max(60).optional(),
  relocate: z.boolean().optional(),
  occupation_ofo: z.string().trim().max(20).optional().refine(v => !v || !!require('../skills').byOfo(v), 'Choose an occupation from the Critical Skills List'),
  experience_years: z.number().int().min(0).max(60).optional(),
  saqa_status: z.enum(['', 'not_started', 'applied', 'evaluated']).optional(),
  prof_body: z.string().trim().max(120).optional(),
  prof_reg_no: z.string().trim().max(60).optional(),
  hourly_rate: z.number().int().min(0).max(100000).optional(),
  province: z.enum(PROVINCES).optional(),
  city: z.string().trim().max(80).optional(),
  languages: z.string().trim().max(120).optional(),
  portfolio: z.array(z.object({ title: z.string().trim().min(2).max(80), url: z.url().max(300).optional().or(z.literal('')), description: z.string().trim().max(300).default('') })).max(12).optional(),
})), (req, res) => {
  const b = req.body;
  const sets = [], args = [];
  // Once identity is verified, residency comes from the ID document and can't be changed here.
  const locked = db.prepare("SELECT kyc_status FROM users WHERE id = ?").get(req.user.id).kyc_status !== 'none';
  if (locked) delete b.residency;
  if (b.residency && b.residency !== 'foreign') b.work_rights = 'yes';
  if (b.relocate !== undefined) b.relocate = b.relocate ? 1 : 0;
  for (const k of ['headline', 'bio', 'hourly_rate', 'province', 'city', 'languages', 'residency', 'work_rights', 'country', 'nationality', 'relocate', 'occupation_ofo', 'experience_years', 'saqa_status', 'prof_body', 'prof_reg_no']) if (b[k] !== undefined) { sets.push(`${k} = ?`); args.push(b[k]); }
  if (b.skills) { sets.push('skills = ?'); args.push(JSON.stringify(b.skills)); }
  if (b.portfolio) { sets.push('portfolio = ?'); args.push(JSON.stringify(b.portfolio)); }
  if (sets.length) db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = ?`).run(...args, req.user.id);
  res.json({ data: db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.user.id) });
});


const n = (sql, ...a) => db.prepare(sql).get(...a).n || 0;

// Country, display currency and company name (international companies post remote jobs; prices still charge in rand).
router.put('/preferences', validate(z.object({ country: z.string().trim().max(60), currency: z.string().trim().length(3), company: z.string().trim().max(120).default('') })), (req, res) => {
  const FX = require('../fx');
  if (!FX.COUNTRIES.some(([n]) => n === req.body.country)) throw new HttpError(400, 'Choose a country from the list');
  if (!FX.CURRENCIES[req.body.currency]) throw new HttpError(400, 'Choose a currency from the list');
  db.prepare('UPDATE users SET country = ?, currency = ?, company = ? WHERE id = ?').run(req.body.country, req.body.currency, req.body.company, req.user.id);
  res.json({ ok: true });
});

router.get('/work-info', requireRole('talent'), (req, res) => {
  const p = db.prepare('SELECT residency, work_rights, country, nationality, relocate, occupation_ofo, experience_years, saqa_status, prof_body, prof_reg_no FROM profiles WHERE user_id = ?').get(req.user.id) || {};
  res.json({ data: { ...p, relocate: !!p.relocate, locked: db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(req.user.id).kyc_status !== 'none' } });
});
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

const NOTE_SELECT = `SELECT n.*, a.name AS actor_name, ap.avatar_color AS actor_color FROM notifications n
  LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN profiles ap ON ap.user_id = n.actor_id`;

router.get('/notifications', validate(z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), 'query'), (req, res) => {
  const { before, limit } = req.q;
  const rows = db.prepare(`${NOTE_SELECT} WHERE n.user_id = ? ${before ? 'AND n.id < ?' : ''} ORDER BY n.id DESC LIMIT ?`).all(req.user.id, ...(before ? [before] : []), limit);
  res.json({ data: rows, unread: n('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', req.user.id) });
});
router.post('/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  emit(req.user.id, 'counts', counts(req.user.id));
  res.status(204).end();
});
router.post('/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  emit(req.user.id, 'counts', counts(req.user.id));
  res.status(204).end();
});
router.get('/counts', (req, res) => res.json(counts(req.user.id)));

// Live stream: notifications, inbox messages and counters are pushed here as they happen.
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  req.socket.setTimeout?.(0);
  const off = subscribe(req.user.id, res);
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(req.user.id);
  send(res, 'ready', { counts: counts(req.user.id) });
  const ping = setInterval(() => send(res, 'ping', { t: Date.now() }), 25000);
  req.on('close', () => { clearInterval(ping); off(); db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(req.user.id); });
});

// Dashboard home: an activity feed ("posts") plus things that need the user's attention.
router.get('/feed', (req, res) => {
  const id = req.user.id, role = req.user.role;
  const activity = db.prepare(`${NOTE_SELECT} WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30`).all(id);
  const C = `SELECT c.id, c.status, c.amount_cents, c.updated_at, j.title AS job_title, cu.name AS client_name, tu.name AS talent_name
    FROM contracts c JOIN jobs j ON j.id = c.job_id JOIN users cu ON cu.id = c.client_id JOIN users tu ON tu.id = c.talent_id`;
  const out = { activity };
  if (role === 'talent') {
    const p = db.prepare('SELECT skills, headline, province FROM profiles WHERE user_id = ?').get(id) || {};
    const words = [...JSON.parse(p.skills || '[]'), ...(p.headline || '').split(/\s+/)].map(w => w.toLowerCase().trim()).filter(w => w.length > 2).slice(0, 12);
    const score = words.length ? words.map(() => '(CASE WHEN LOWER(j.title || \' \' || j.description || \' \' || j.category) LIKE ? THEN 1 ELSE 0 END)').join(' + ') : '0';
    out.recommended = db.prepare(`SELECT j.*, (${score}) + (CASE WHEN j.province = ? THEN 1 ELSE 0 END) AS score FROM jobs j
      WHERE j.status = 'open' AND j.id NOT IN (SELECT job_id FROM applications WHERE user_id = ?) ORDER BY score DESC, j.featured DESC, j.created_at DESC LIMIT 6`)
      .all(...words.map(w => `%${w}%`), p.province || '', id).map(j => ({ ...shape(j), match: j.score }));
    out.todo = [
      ...db.prepare(`${C} WHERE c.talent_id = ? AND c.status = 'offered' ORDER BY c.updated_at DESC`).all(id).map(c => ({ kind: 'offer', text: `Respond to ${c.client_name}'s offer for "${c.job_title}"`, link: `#contracts/${c.id}`, contract: c })),
      ...db.prepare(`${C} WHERE c.talent_id = ? AND c.status = 'funded' ORDER BY c.updated_at DESC`).all(id).map(c => ({ kind: 'work', text: `Deliver "${c.job_title}" for ${c.client_name}`, link: `#contracts/${c.id}`, contract: c })),
    ];
  } else {
    out.recent_bids = db.prepare(`SELECT a.id, a.bid_amount, a.delivery_days, a.created_at, a.status, j.id AS job_id, j.title, u.name, u.id AS talent_id, p.rating, p.verified, p.avatar_color
      FROM applications a JOIN jobs j ON j.id = a.job_id JOIN users u ON u.id = a.user_id LEFT JOIN profiles p ON p.user_id = u.id
      WHERE j.client_id = ? ORDER BY a.id DESC LIMIT 8`).all(id).map(r => ({ ...r, verified: !!r.verified }));
    out.todo = [
      ...db.prepare(`${C} WHERE c.client_id = ? AND c.status = 'accepted' ORDER BY c.updated_at DESC`).all(id).map(c => ({ kind: 'fund', text: `${c.talent_name} accepted. Fund escrow for "${c.job_title}"`, link: `#contracts/${c.id}`, contract: c })),
      ...db.prepare(`${C} WHERE c.client_id = ? AND c.status = 'delivered' ORDER BY c.updated_at DESC`).all(id).map(c => ({ kind: 'review', text: `Review the delivered work for "${c.job_title}"`, link: `#contracts/${c.id}`, contract: c })),
      ...db.prepare(`SELECT j.id, j.title, COUNT(a.id) n FROM jobs j JOIN applications a ON a.job_id = j.id AND a.status = 'submitted' WHERE j.client_id = ? AND j.status = 'open' GROUP BY j.id ORDER BY MAX(a.id) DESC`).all(id)
        .map(j => ({ kind: 'bids', text: `${j.n} new bid${j.n > 1 ? 's' : ''} to review on "${j.title}"`, link: `#job/${j.id}/bids` })),
    ];
  }
  res.json(out);
});

router.post('/verification', requireRole('talent', 'client'), upload.single('document'), validate(z.object({
  id_type: z.enum(['SA ID', 'Passport', 'Trade certificate', 'Company (CIPC)']),
  reference: z.string().trim().min(4).max(40), note: z.string().trim().max(500).default(''),
})), (req, res) => {
  if (db.prepare("SELECT 1 FROM verifications WHERE user_id = ? AND status = 'pending'").get(req.user.id)) throw new HttpError(409, 'You already have a request under review');
  if (req.file && !realType(req.file)) { fs.unlink(req.file.path, () => {}); throw new HttpError(400, 'That file does not look like a valid PDF, JPG or PNG'); }
  // POPIA data minimisation: only the last 4 characters of the number are stored; the file is deleted after review.
  db.prepare('INSERT INTO verifications (user_id,id_type,ref_last4,note,doc_path,doc_mime) VALUES (?,?,?,?,?,?)').run(req.user.id, req.body.id_type, req.body.reference.slice(-4), req.body.note, req.file?.filename || '', req.file?.mimetype || '');
  res.status(201).json({ ok: true });
});

router.post('/report', validate(z.object({ target_type: z.enum(['job', 'user', 'contract']), target_id: z.number().int(), reason: z.string().trim().min(10).max(1000) })), (req, res) => {
  db.prepare('INSERT INTO reports (reporter_id,target_type,target_id,reason) VALUES (?,?,?,?)').run(req.user.id, req.body.target_type, req.body.target_id, req.body.reason);
  res.status(201).json({ ok: true });
});

router.post('/password', validate(z.object({ current: z.string().min(1), password: z.string().min(8).max(100).refine(p => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and at least one number') })), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(req.body.current, u.password_hash)) throw new HttpError(401, 'Your current password is incorrect');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 11), u.id);
  res.json({ ok: true });
});

// POPIA: right of access
router.get('/export', (req, res) => {
  const id = req.user.id, all = (sql) => db.prepare(sql).all(id);
  res.setHeader('Content-Disposition', 'attachment; filename="talentbridge-my-data.json"');
  res.json({
    exported_at: new Date().toISOString(),
    account: db.prepare('SELECT id,name,email,phone,role,status,consent_at,created_at FROM users WHERE id = ?').get(id),
    profile: db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(id) || null,
    jobs: all('SELECT * FROM jobs WHERE client_id = ?'), applications: all('SELECT * FROM applications WHERE user_id = ?'),
    contracts: all('SELECT * FROM contracts WHERE client_id = ? OR talent_id = ?'.replace('talent_id = ?', 'talent_id = ' + id)),
    messages: all('SELECT * FROM messages WHERE sender_id = ?'), notifications: all('SELECT * FROM notifications WHERE user_id = ?'),
    inbox_messages: all('SELECT id, conversation_id, body, attachment_name, created_at FROM chat_messages WHERE sender_id = ?'),
    identity_verification: (() => {
      const k = db.prepare('SELECT * FROM kyc_profiles WHERE user_id = ?').get(id);
      if (!k) return null;
      const { id_number_enc, id_number_hash, reviewer_id, ...rest } = k;
      const { decryptText } = require('../vault');
      return { ...rest, id_number: id_number_enc ? decryptText(id_number_enc) : '', status: db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(id).kyc_status,
        documents: all("SELECT kind, file_name, mime, size, status, note, uploaded_at, reviewed_at FROM kyc_documents WHERE user_id = ? AND status != 'replaced'"),
        qualifications: all('SELECT institution, qualification, field, year, student_number, certificate_number, status, verified_at FROM qualifications WHERE user_id = ?'),
        bank_account: db.prepare('SELECT holder, bank, account_last4, branch_code, account_type, changed_at FROM bank_accounts WHERE user_id = ?').get(id) || null };
    })(),
  });
});

// POPIA: right to deletion. Financial records are kept (tax law) but the person is anonymised.
router.post('/delete', validate(z.object({ password: z.string().min(1) })), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (u.role === 'admin') throw new HttpError(403, 'Admin accounts cannot be self-deleted');
  if (!bcrypt.compareSync(req.body.password, u.password_hash)) throw new HttpError(401, 'Incorrect password');
  if (n("SELECT COUNT(*) n FROM contracts WHERE (client_id = ? OR talent_id = ?) AND status IN ('offered','accepted','funded','delivered','disputed','released')", u.id, u.id)) throw new HttpError(409, 'Finish or cancel your active contracts first');
  db.transaction(() => {
    db.prepare("UPDATE users SET name='Deleted user', email=?, phone='', status='deleted', password_hash=? WHERE id=?").run(`deleted+${u.id}@talentbridge.invalid`, bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 4), u.id);
    db.prepare("UPDATE profiles SET headline='', bio='', skills='[]', city='', verified=0 WHERE user_id=?").run(u.id);
    db.prepare("UPDATE jobs SET status='closed' WHERE client_id=?").run(u.id);
    db.prepare('DELETE FROM saved_jobs WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM notifications WHERE user_id=?').run(u.id);
    // Identity records are kept encrypted for the legal retention period (fraud and anti-money-laundering records); the CV is not needed and is removed.
    const cvs = db.prepare("SELECT file_path FROM kyc_documents WHERE user_id = ? AND kind = 'cv'").all(u.id);
    db.prepare("DELETE FROM kyc_documents WHERE user_id = ? AND kind = 'cv'").run(u.id);
    for (const c of cvs) fs.unlink(require('path').join(require('./kyc').KYC_DIR, require('path').basename(c.file_path)), () => {});
  })();
  res.status(204).end();
});

module.exports = router;
