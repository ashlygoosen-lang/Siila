require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { ZodError } = require('zod');

const db = require('./db');
const { seed } = require('./seed');
const { HttpError, PROVINCES, CATEGORIES, TYPES } = require('./util');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
    },
  },
}));
const origins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : !isProd }));
app.use(compression());
app.use(express.json({ limit: '50kb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan(isProd ? 'combined' : 'dev'));

app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts, try again later' } }));

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/meta', (_req, res) => res.json({ provinces: PROVINCES, categories: CATEGORIES, types: TYPES }));
app.get('/api/stats', (_req, res) => {
  const c = (sql) => db.prepare(sql).get().c;
  res.json({
    professionals: c("SELECT COUNT(*) c FROM users WHERE role='talent'"),
    verified: c('SELECT COUNT(*) c FROM profiles WHERE verified = 1'),
    open_jobs: c("SELECT COUNT(*) c FROM jobs WHERE status='open'"),
    provinces: c("SELECT COUNT(DISTINCT province) c FROM jobs"),
    avg_rating: Number((db.prepare('SELECT AVG(rating) a FROM profiles WHERE rating > 0').get().a || 0).toFixed(1)),
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/talent', require('./routes/talent'));
app.use('/api/me', require('./routes/me'));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endpoint not found')));

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: isProd ? '1h' : 0 }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

// Demo accounts share a public password, so they are only seeded outside production unless SEED_DEMO=true
const seedDemo = process.env.SEED_DEMO ? process.env.SEED_DEMO === 'true' : !isProd;
if (seedDemo && seed()) console.log('Seeded demo data (password for demo accounts: Siira#2026)');

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`SIIRA API listening on http://localhost:${port}`));
}
module.exports = app;
