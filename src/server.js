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
      // the checkout form posts straight to PayFast's payment page
      'form-action': ["'self'", 'https://www.payfast.co.za', 'https://sandbox.payfast.co.za'],
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
  sponsorship: { wait_days: require('./sponsor').WAIT_DAYS, min_months: require('./sponsor').MIN_MONTHS },
  critical_skills: require('./skills').CRITICAL.map(c => ({ ofo: c.ofo, name: c.name, field: c.field })),
  countries: require('./fx').COUNTRIES, currencies: require('./fx').CURRENCIES,
  escrow_periods: require('./escrow').PERIOD_LABEL, remote_categories: require('./remotefeed').GROUPS,
}));
// Full South African skills catalogue: Critical Skills List (with NQF level and registration) and general skills by category.
app.get('/api/skills', (req, res) => {
  const S = require('./skills');
  if (req.query.q !== undefined) return res.json({ data: S.search(String(req.query.q).slice(0, 60), { limit: 30 }) });
  res.json({ data: { source: S.CRITICAL_SOURCE, critical: S.CRITICAL, general: S.GENERAL } });
});
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

// PayFast self-test (sandbox only): posts a signed R5 test payment to the PayFast sandbox and reports whether the
// ITN that comes back passes every check. Used to prove the integration on the real server before going live.
const selftests = new Map();
app.get('/api/payfast/selftest', (req, res) => {
  const PF = require('./payfast');
  if (!PF.isSandbox()) return res.status(404).json({ error: 'Only available in PayFast sandbox mode' });
  if (!PF.configured()) return res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><title>PayFast self-test</title><body style="font:16px system-ui;padding:40px;max-width:640px;line-height:1.5">
<h1 style="font-size:24px">PayFast isn’t set up yet</h1><ol><li>Create a free sandbox account at <a href="https://sandbox.payfast.co.za">sandbox.payfast.co.za</a>.</li>
<li>In it, open Settings → Developer settings, note the Merchant ID and Merchant Key, and set a passphrase.</li>
<li>In Railway → Variables set <code>PAYMENTS_MODE=payfast</code>, <code>PAYFAST_SANDBOX=true</code>, <code>PAYFAST_MERCHANT_ID</code>, <code>PAYFAST_MERCHANT_KEY</code> and <code>PAYFAST_PASSPHRASE</code>.</li>
<li>Open this page again to send a R5 test payment.</li></ol>`);
  const { baseUrl } = require('./services');
  const ref = 'SELFTEST-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  selftests.set(ref, { created: Date.now(), itn: null });
  for (const [k, v] of selftests) if (Date.now() - v.created > 3600e3) selftests.delete(k);
  const b = baseUrl(req);
  const out = PF.checkout({ reference: ref, amountCents: 500, itemName: 'TalentBridge PayFast self-test', itemDescription: 'Sandbox test payment & signature check', buyer: { first: 'Test', last: 'Buyer', email: 'sbtu01@payfast.io' }, contractId: 0, baseUrl: b });
  out.fields.return_url = `${b}/api/payfast/selftest/result?ref=${ref}`; out.fields.cancel_url = out.fields.return_url;
  const { signature, ...unsigned } = out.fields; out.fields.signature = PF.checkoutSignature(unsigned, PF.creds().pass);
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>PayFast self-test</title><body style="font:16px system-ui;padding:40px"><p>Sending a R5.00 sandbox test payment to PayFast…</p>
<form id="f" method="post" action="${esc(out.action)}">${Object.entries(out.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button>Continue to PayFast</button></form>
<script>document.getElementById('f').submit()</script>`);
});
app.get('/api/payfast/selftest/result', (req, res) => {
  const st = selftests.get(String(req.query.ref || ''));
  if (!st) return res.status(404).type('html').send('<p style="font:16px system-ui;padding:40px">Unknown or expired test.</p>');
  const r = st.itn;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>PayFast self-test</title>${r ? '' : '<meta http-equiv="refresh" content="3">'}<body style="font:16px system-ui;padding:40px;max-width:640px">
<h1 style="font-size:24px">PayFast self-test</h1><p>Reference: <code>${req.query.ref}</code></p>
${!r ? '<p>Waiting for PayFast’s notification (ITN)… this page refreshes every 3 seconds.</p>'
    : r.ok ? `<p style="color:#1f6b45;font-weight:700">ITN received and verified: signature, PayFast server address and PayFast confirmation all passed. Payment status: ${r.status}.</p>`
    : `<p style="color:#b42318;font-weight:700">ITN received but rejected: ${r.reason}.</p>`}`);
});

// PayFast ITN: PayFast posts here after every payment. Nothing is trusted until verifyItn() passes all four checks.
app.post('/api/webhooks/payfast', express.urlencoded({ extended: false, limit: '20kb', verify: (req, _res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  const PF = require('./payfast');
  const { audit } = require('./services');
  const v = await PF.verifyItn(req.rawBody ? req.rawBody.toString('utf8') : '', req.ip);
  const d = v.data || {};
  const st = selftests.get(d.m_payment_id);
  if (st) { st.itn = { ok: v.ok, reason: v.reason || '', status: d.payment_status || '', at: new Date().toISOString() }; return res.sendStatus(v.ok ? 200 : 400); }
  if (!v.ok) {
    console.warn(`PayFast ITN rejected (${v.reason}) ref=${d.m_payment_id || '-'} ip=${req.ip}`);
    audit(null, 'payment.itn_rejected', d.m_payment_id || '', { reason: v.reason, ip: req.ip });
    return res.sendStatus(400);
  }
  const p = db.prepare('SELECT * FROM payments WHERE reference = ?').get(d.m_payment_id);
  const dep = !p && db.prepare('SELECT * FROM job_deposits WHERE reference = ?').get(d.m_payment_id);
  if (dep) { // upfront escrow for a remote job
    const gross = Math.round(parseFloat(d.amount_gross) * 100);
    audit(null, 'escrow.itn_' + String(d.payment_status || '').toLowerCase(), dep.reference, { pf: d.pf_payment_id, gross, fee: d.amount_fee, net: d.amount_net });
    if (gross !== dep.amount_cents) { console.warn(`PayFast amount mismatch ref=${dep.reference} expected=${dep.amount_cents} got=${gross}`); return res.sendStatus(200); }
    if (d.payment_status === 'COMPLETE') require('./escrow').markDepositPaid(dep.reference, d.pf_payment_id);
    else if (d.payment_status === 'CANCELLED' && dep.status === 'pending') db.prepare("UPDATE job_deposits SET status = 'cancelled' WHERE id = ?").run(dep.id);
    return res.sendStatus(200);
  }
  if (!p) { audit(null, 'payment.itn_unknown', d.m_payment_id || '', { pf: d.pf_payment_id }); return res.sendStatus(200); }
  const gross = Math.round(parseFloat(d.amount_gross) * 100);
  audit(null, 'payment.itn_' + String(d.payment_status || '').toLowerCase(), p.reference, { pf: d.pf_payment_id, gross, fee: d.amount_fee, net: d.amount_net });
  if (gross !== p.amount_cents) { console.warn(`PayFast amount mismatch ref=${p.reference} expected=${p.amount_cents} got=${gross}`); return res.sendStatus(200); }
  if (d.payment_status === 'COMPLETE') {
    db.prepare('UPDATE payments SET provider_ref = ? WHERE id = ?').run(String(d.pf_payment_id || ''), p.id);
    markFunded(p.contract_id, p.reference);
  } else if (d.payment_status === 'CANCELLED' && p.status === 'pending') {
    db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(p.id);
  }
  res.sendStatus(200);
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

app.use('/api', require('./routes/remote'));
app.use('/api', require('./routes/public'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/talent', require('./routes/talent'));
app.use('/api/me', require('./routes/me'));
app.use('/api/contracts', require('./routes/contracts'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/kyc', require('./routes/kyc'));
const spons = require('./routes/sponsorships');
app.use('/api/sponsorships', spons.router);
app.use('/api/admin', spons.admin);
app.use('/api/admin', require('./routes/kyc-admin'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endpoint not found')));

const base = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /api/\nDisallow: /app.html\nSitemap: ${base(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/remote.html', '/skills.html', '/terms.html', '/privacy.html', '/refunds.html'].map(p => `<url><loc>${base(req)}${p}</loc></url>`).join('')}</urlset>`));
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
  const srv = app.listen(port, () => { console.log(`TalentBridge API listening on http://localhost:${port}`); if (isProd) require('./readiness').logReport(); });
  require('./remotefeed').start();
  if (process.env.NODE_ENV !== 'test') { require('./fx').refresh().catch(() => {}); setInterval(() => require('./fx').refresh().catch(() => {}), 3 * 3600 * 1000).unref(); }
  const stop = () => srv.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  if (isProd && process.env.BACKUP_DAILY !== 'false') { // daily SQLite backup, keeps the last 14
    const run = () => backup().catch(e => console.error('Backup failed:', e.message));
    setTimeout(run, 30000).unref(); setInterval(run, 24 * 3600 * 1000).unref();
  }
}
module.exports = app;
