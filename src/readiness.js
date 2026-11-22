// Launch checklist: what is configured and what still needs doing before taking real customers.
const fs = require('fs');
const path = require('path');
const db = require('./db');

function checks() {
  const prod = process.env.NODE_ENV === 'production';
  const PF = require('./payfast');
  const mode = require('./services').paymentsMode();
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'siira.db');
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  const keyFile = path.join(path.dirname(dbPath), '.data_key');
  const demo = db.prepare("SELECT COUNT(*) n FROM users WHERE email LIKE '%@talentbridge.test'").get().n;
  const app = process.env.APP_URL || '';
  const c = [
    { key: 'storage', group: 'Hosting', ok: !onRailway || (!!vol && dbPath.startsWith(vol)), label: 'Database and uploads on a persistent volume',
      fix: 'In Railway, add a Volume to this service (mount path such as /data). The app then stores the database, uploads and backups there automatically.' },
    { key: 'app_url', group: 'Hosting', ok: /^https:\/\//.test(app), label: 'Public site address (APP_URL) set with https',
      fix: 'Set APP_URL to your public address, e.g. https://talentbridge.co.za. PayFast and email links use it.' },
    { key: 'jwt', group: 'Security', ok: !!process.env.JWT_SECRET && process.env.JWT_SECRET !== 'change-me' && process.env.JWT_SECRET.length >= 32, label: 'Login signing secret (JWT_SECRET) set',
      fix: 'Set JWT_SECRET to a long random value (openssl rand -hex 48).' },
    { key: 'data_key', group: 'Security', ok: /^[0-9a-f]{64}$/i.test(process.env.DATA_KEY || '') || (!!process.env.DATA_KEY && Buffer.from(process.env.DATA_KEY, 'base64').length === 32), label: 'Encryption key for ID documents and bank details (DATA_KEY) set',
      fix: `Set DATA_KEY (openssl rand -hex 32) and keep a copy offline.${fs.existsSync(keyFile) ? ' A generated key exists beside the database: copy its value into DATA_KEY so it can never be lost.' : ''}` },
    { key: 'demo', group: 'Security', ok: demo === 0, label: 'No demo accounts in the live database',
      fix: 'Demo accounts share a public password. Set SEED_DEMO=false and start from a fresh database, or suspend the @talentbridge.test accounts.' },
    { key: 'payments', group: 'Payments', ok: mode === 'payfast' || mode === 'paystack' || mode === 'manual', label: `Payment method chosen (now: ${mode})`,
      fix: 'Set PAYMENTS_MODE=payfast to take card and Instant EFT payments through PayFast (or manual for EFT you confirm yourself).' },
    { key: 'payfast_live', group: 'Payments', ok: mode !== 'payfast' || (!PF.isSandbox() && PF.configured()), label: 'PayFast live merchant details set',
      fix: 'Set PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY and PAYFAST_PASSPHRASE from your PayFast dashboard (Settings > Developer settings), then PAYFAST_SANDBOX=false. Set the same passphrase in PayFast.' },
    { key: 'smtp', group: 'Email', ok: !!process.env.SMTP_HOST && !!process.env.SMTP_USER, label: 'Email sending (SMTP) configured',
      fix: 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM. Without them, verification and password-reset emails are not sent.' },
    { key: 'company', group: 'Legal', ok: !!process.env.COMPANY_ADDRESS && !!process.env.INFO_OFFICER && !!process.env.SUPPORT_PHONE, label: 'Company address, Information Officer and phone set',
      fix: 'Set COMPANY_ADDRESS, INFO_OFFICER and SUPPORT_PHONE (and VAT_NUMBER if registered). They fill the Terms, Privacy Policy and invoices.' },
    { key: 'backups', group: 'Hosting', ok: process.env.BACKUP_DAILY !== 'false', label: 'Daily database backups on',
      fix: 'Remove BACKUP_DAILY=false. Backups are kept for 14 days beside the database; copy them off-site regularly.' },
  ];
  return { production: prod, ready: c.every(x => x.ok), checks: c };
}

function logReport() {
  const r = checks();
  const missing = r.checks.filter(c => !c.ok);
  if (!missing.length) return console.log('Launch checklist: all set.');
  console.warn(`Launch checklist: ${missing.length} item(s) to finish:\n` + missing.map(c => `  - ${c.label}: ${c.fix}`).join('\n'));
}
module.exports = { checks, logReport };
