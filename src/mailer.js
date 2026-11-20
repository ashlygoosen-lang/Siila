const nodemailer = require('nodemailer');

const outbox = []; // captured in tests
let tx = null;

function transport() {
  if (tx !== null) return tx;
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  tx = SMTP_HOST ? nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: SMTP_SECURE === 'true', auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined }) : false;
  return tx;
}

async function sendMail(to, subject, text) {
  if (!to) return;
  if (process.env.NODE_ENV === 'test') { outbox.push({ to, subject, text }); return; }
  const t = transport();
  if (!t) { // no SMTP configured: never print tokens/links in production logs
    console.log(process.env.NODE_ENV === 'production' ? `[mail not sent: SMTP not configured] to=${to} subject=${subject}` : `[mail] to=${to}\n${subject}\n${text}\n`);
    return;
  }
  try { await t.sendMail({ from: process.env.MAIL_FROM || 'SIIRA <no-reply@siira.co.za>', to, subject, text }); }
  catch (e) { console.error('Mail failed:', e.message); }
}

module.exports = { sendMail, outbox };
