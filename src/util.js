const jwt = require('jsonwebtoken');
const { z } = require('zod');

const isProd = process.env.NODE_ENV === 'production';
if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me')) {
  throw new Error('JWT_SECRET must be set to a strong random value in production');
}
const SECRET = process.env.JWT_SECRET || 'dev-only-secret';

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
