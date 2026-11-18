const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { HttpError, signToken, auth, validate, z, PROVINCES } = require('../util');

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

router.post('/register', validate(z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(160),
  password: z.string().min(8).max(100)
    .refine(p => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and at least one number'),
  role: z.enum(['talent', 'client']),
  province: z.enum(PROVINCES).optional(),
})), (req, res) => {
  const { name, email, password, role, province } = req.body;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists');
  const hash = bcrypt.hashSync(password, 11);
  const id = db.transaction(() => {
    const uid = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run(name, email, hash, role).lastInsertRowid;
    if (role === 'talent') db.prepare('INSERT INTO profiles (user_id, province) VALUES (?,?)').run(uid, province || '');
    return uid;
  })();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', validate(z.object({ email: z.email(), password: z.string().min(1) })), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(req.body.email);
  // Same message for unknown email and wrong password to avoid account enumeration
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) throw new HttpError(401, 'Incorrect email or password');
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', auth(), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) throw new HttpError(401, 'Account no longer exists');
  res.json({ user: publicUser(user) });
});

module.exports = router;
