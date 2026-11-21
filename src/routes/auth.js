const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { HttpError, signToken, auth, validate, z, PROVINCES } = require('../util');
const { baseUrl, createToken, consumeToken } = require('../services');
const { sendMail } = require('../mailer');

const password = z.string().min(8).max(100).refine(p => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and at least one number');
function sendVerify(req, user) {
  const t = createToken(user.id, 'verify', 60 * 24 * 3);
  sendMail(user.email, 'Verify your TalentBridge email', `Hi ${user.name},\n\nConfirm your email address to start using TalentBridge:\n${baseUrl(req)}/api/auth/verify-email?token=${t}\n\nThe link works for 3 days.`);
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, email_verified: !!u.email_verified });

router.post('/register', validate(z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(160),
  password: z.string().min(8).max(100)
    .refine(p => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and at least one number'),
  role: z.enum(['talent', 'client']),
  province: z.enum(PROVINCES).optional(),
  phone: z.string().trim().max(20).optional(),
  accept_terms: z.literal(true, { error: 'You must accept the Terms and Privacy Policy (POPIA consent)' }),
})), (req, res) => {
  const { name, email, password, role, province, phone } = req.body;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists');
  const hash = bcrypt.hashSync(password, 11);
  const id = db.transaction(() => {
    const uid = db.prepare('INSERT INTO users (name,email,password_hash,role,phone,consent_at) VALUES (?,?,?,?,?,datetime(\'now\'))').run(name, email, hash, role, phone || '').lastInsertRowid;
    if (role === 'talent') db.prepare('INSERT INTO profiles (user_id, province, avatar_color) VALUES (?,?,?)').run(uid, province || '', ['#6a4bd8', '#2e7d5b', '#b4562e', '#3b6fb6', '#8a5a00', '#17241f'][uid % 6]);
    return uid;
  })();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  sendVerify(req, user);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', validate(z.object({ email: z.email(), password: z.string().min(1) })), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email);
  // Same message for unknown email and wrong password to avoid account enumeration
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) throw new HttpError(401, 'Incorrect email or password');
  if (user.status !== 'active') throw new HttpError(403, 'This account is not active. Contact support.');
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', auth(), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) throw new HttpError(401, 'Account no longer exists');
  res.json({ user: publicUser(user) });
});

router.get('/verify-email', (req, res) => {
  const uid = consumeToken('verify', req.query.token);
  if (uid) db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(uid);
  res.redirect(uid ? '/app.html#verified' : '/app.html#link-expired');
});
router.post('/resend-verification', auth(), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u.email_verified) sendVerify(req, u);
  res.json({ ok: true });
});
// Same response whether or not the email exists (no account enumeration)
router.post('/forgot', validate(z.object({ email: z.email() })), (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(req.body.email);
  if (u) sendMail(u.email, 'Reset your TalentBridge password', `Hi ${u.name},\n\nReset your password here (valid for 1 hour):\n${baseUrl(req)}/app.html#reset=${createToken(u.id, 'reset', 60)}\n\nIf you did not ask for this, ignore this email.`);
  res.json({ ok: true });
});
router.post('/reset', validate(z.object({ token: z.string().min(20).max(200), password })), (req, res) => {
  const uid = consumeToken('reset', req.body.token);
  if (!uid) throw new HttpError(400, 'This reset link is invalid or has expired');
  db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(bcrypt.hashSync(req.body.password, 11), uid);
  res.json({ ok: true });
});

module.exports = router;
