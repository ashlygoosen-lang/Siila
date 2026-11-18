const jwt = require('jsonwebtoken');
const { z } = require('zod');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';

// Prefer JWT_SECRET from the environment. If it is missing in production, generate a strong random
// secret and keep it next to the database so logins survive restarts (set JWT_SECRET yourself to be safe).
function loadSecret() {
  const env = process.env.JWT_SECRET;
  if (env && env !== 'change-me') return env;
  if (!isProd) return 'dev-only-secret';
  const dir = path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'siira.db'));
  const file = path.join(dir, '.jwt_secret');
  console.warn('WARNING: JWT_SECRET is not set. Using an auto-generated secret. Set JWT_SECRET in your host variables.');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const secret = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    return crypto.randomBytes(48).toString('hex'); // read-only disk: valid until the next restart
  }
}
const SECRET = loadSecret();

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

function auth(required = true) {
  return (req, _res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return required ? next(new HttpError(401, 'Authentication required')) : next();
    try {
      const p = jwt.verify(token, SECRET);
      req.user = { id: p.sub, role: p.role };
      next();
    } catch {
      next(new HttpError(401, 'Invalid or expired token'));
    }
  };
}

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, 'You do not have permission to do that'));

const validate = (schema, source = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[source]);
  if (!r.success) {
    return next(new HttpError(400, 'Validation failed', r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message }))));
  }
  if (source === 'query') req.q = r.data; else req[source] = r.data;
  next();
};

const money = (n) => 'R' + Number(n).toLocaleString('en-ZA').replace(/\s/g, ' ');
const payLabel = (j) => `${money(j.pay_min)} – ${money(j.pay_max)}/${j.pay_unit}`;

const PROVINCES = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'];
const CATEGORIES = ['Trades & Repairs', 'Construction', 'Cleaning & Care', 'Creative & Digital', 'Transport & Delivery', 'Business Support'];
const TYPES = ['Full-Time', 'Part-Time', 'Freelance', 'Short-Term'];

module.exports = { HttpError, signToken, auth, requireRole, validate, payLabel, PROVINCES, CATEGORIES, TYPES, z };
