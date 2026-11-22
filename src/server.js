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
const crypto = require('crypto');
const { seed, ensureAdmin } = require('./seed');
const { markFunded, setting } = require('./services');
const { HttpError, PROVINCES, CATEGORIES, TYPES } = require('./util');
const fs = require('fs');
const { backup } = require('./backup');

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
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
    },
  },
}));
const origins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : !isProd }));
// The live stream must not be buffered by compression.
app.use(compression({ filter: (req, res) => req.path === '/api/me/stream' ? false : compression.filter(req, res) }));
app.use(express.json({ limit: '50kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
if (process.env.NODE_ENV !== 'test') app.use(morgan(isProd ? 'combined' : 'dev'));

app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1500, skip: (req) => req.path === '/me/stream' || /\/typing$/.test(req.path), standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts, try again later' } }));

app.get('/api/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, time: new Date().toISOString() }); });
app.get('/api/meta', (_req, res) => res.json({
  brand: { name: 'TalentBridge', tagline: 'Hire trusted South African talent' },
  provinces: PROVINCES, types: TYPES, pay_units: ['hour', 'day', 'month', 'project'],
  categories: CATEGORIES.map(name => ({ name, open_jobs: db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='open' AND category = ?").get(name).c,
    professionals: db.prepare("SELECT COUNT(DISTINCT a.user_id) c FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.category = ?").get(name).c })),
  commission_pct: setting('commission_pct', 10), vat_pct: setting('vat_pct', 15),
}));
app.get('/api/stats', (_req, res) => {
  const c = (sql) => db.prepare(sql).get().c;
  res.json({
    professionals: c("SELECT COUNT(*) c FROM users WHERE role='talent'"),
    verified: c('SELECT COUNT(*) c FROM profiles WHERE verified = 1'),
    open_jobs: c("SELECT COUNT(*) c FROM jobs WHERE status='open'"),
    provinces: c("SELECT COUNT(DISTINCT province) c FROM jobs"),
    avg_rating: Number((db.prepare('SELECT AVG(rating) a FROM profiles WHERE rating > 0').get().a || 0).toFixed(1)),
    clients: c("SELECT COUNT(*) c FROM users WHERE role='client'"),
    jobs_completed: c("SELECT COUNT(*) c FROM contracts WHERE status IN ('released','paid_out')") + (db.prepare('SELECT SUM(jobs_done) c FROM profiles').get().c || 0),
    paid_out_cents: db.prepare("SELECT IFNULL(SUM(payout_cents),0) c FROM contracts WHERE status IN ('released','paid_out')").get().c,
    bids_this_week: c("SELECT COUNT(*) c FROM applications WHERE created_at > datetime('now','-7 days')"),
    reviews: c('SELECT COUNT(*) c FROM reviews'),
  });
});

app.post('/api/webhooks/paystack', (req, res) => {
  const secret = process.env.PAYSTACK_SECRET;
  if (!secret) return res.sendStatus(404);
  const sig = Buffer.from(crypto.createHmac('sha512', secret).update(req.rawBody || '').digest('hex'));
  const got = Buffer.from(String(req.headers['x-paystack-signature'] || ''));
  if (sig.length !== got.length || !crypto.timingSafeEqual(sig, got)) return res.sendStatus(401);
  if (req.body.event === 'charge.success') {
    const p = db.prepare('SELECT * FROM payments WHERE reference = ?').get(req.body.data.reference);
    if (p && Number(req.body.data.amount) === p.amount_cents) markFunded(p.contract_id, p.reference); // amount must match
  }
  res.sendStatus(200);
});

app.use('/api', require('./routes/public'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/talent', require('./routes/talent'));
app.use('/api/me', require('./routes/me'));
app.use('/api/contracts', require('./routes/contracts'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/kyc', require('./routes/kyc'));
app.use('/api/admin', require('./routes/kyc-admin'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endpoint not found')));

const base = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /api/\nDisallow: /app.html\nSitemap: ${base(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/terms.html', '/privacy.html', '/refunds.html'].map(p => `<url><loc>${base(req)}${p}</loc></url>`).join('')}</urlset>`));
// Pages, styles and scripts are revalidated on every visit so a new deploy shows at once;
// photos, fonts and icons are cached for a week.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: isProd ? '7d' : 0,
  setHeaders: (res, file) => { if (/\.(html|css|js|json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (req.file?.path) fs.unlink(req.file.path, () => {}); // drop uploads from failed requests (memory uploads have no path)
  if (err.name === 'MulterError') return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large. Upload a smaller file' : 'Upload failed' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

// Demo accounts share a public password, so they are only seeded outside production unless SEED_DEMO=true
const seedDemo = process.env.SEED_DEMO ? process.env.SEED_DEMO === 'true' : !isProd;
if (ensureAdmin()) console.log('Created admin account from ADMIN_EMAIL');
if (seedDemo && seed()) console.log('Seeded demo data (password for demo accounts: TalentBridge#2026)');

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const srv = app.listen(port, () => console.log(`TalentBridge API listening on http://localhost:${port}`));
  const stop = () => srv.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  if (isProd && process.env.BACKUP_DAILY !== 'false') { // daily SQLite backup, keeps the last 14
    const run = () => backup().catch(e => console.error('Backup failed:', e.message));
    setTimeout(run, 30000).unref(); setInterval(run, 24 * 3600 * 1000).unref();
  }
}
module.exports = app;
