const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { validate, z } = require('../util');
const { company } = require('../services');
const { sendMail } = require('../mailer');

router.get('/config', (_req, res) => res.json({ company: company(), draft: !process.env.SUPPORT_EMAIL }));

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many messages, please try again later' } });
router.post('/contact', limiter, validate(z.object({
  name: z.string().trim().min(2).max(80), email: z.email(), topic: z.enum(['General', 'Hiring', 'Finding work', 'Payments', 'Verification', 'Privacy request']).default('General'),
  message: z.string().trim().min(10).max(3000), website: z.string().max(200).optional(), // honeypot
})), (req, res) => {
  if (req.body.website) return res.status(201).json({ ok: true }); // bot
  const { name, email, topic, message } = req.body;
  db.prepare('INSERT INTO contact_messages (name,email,topic,message) VALUES (?,?,?,?)').run(name, email, topic, message);
  sendMail(process.env.SUPPORT_EMAIL, `TalentBridge enquiry: ${topic}`, `From: ${name} <${email}>\n\n${message}`);
  res.status(201).json({ ok: true });
});
// Real client reviews for the homepage (only written ones, 4 stars and up).
router.get('/reviews', (_req, res) => {
  const rows = db.prepare(`SELECT rv.rating, rv.comment, rv.created_at, cu.name AS client_name, tu.name AS talent_name, tu.id AS talent_id,
      p.headline, p.avatar_color, j.title AS job_title, j.city
    FROM reviews rv JOIN users cu ON cu.id = rv.reviewer_id JOIN users tu ON tu.id = rv.talent_id LEFT JOIN profiles p ON p.user_id = tu.id
    JOIN contracts c ON c.id = rv.contract_id JOIN jobs j ON j.id = c.job_id
    WHERE rv.rating >= 4 AND LENGTH(TRIM(rv.comment)) >= 15 AND cu.status = 'active' AND tu.status = 'active' ORDER BY rv.id DESC LIMIT 6`).all();
  const short = (n) => n.split(' ')[0] + (n.split(' ')[1] ? ' ' + n.split(' ')[1][0] + '.' : '');
  res.json({ data: rows.map(r => ({ ...r, client_name: short(r.client_name) })) });
});

// Open jobs and professionals per province.
router.get('/provinces', (_req, res) => {
  const { PROVINCES } = require('../util');
  const jobs = Object.fromEntries(db.prepare("SELECT province, COUNT(*) n FROM jobs WHERE status = 'open' GROUP BY province").all().map(r => [r.province, r.n]));
  const pros = Object.fromEntries(db.prepare("SELECT p.province, COUNT(*) n FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.status = 'active' GROUP BY p.province").all().map(r => [r.province, r.n]));
  res.json({ data: PROVINCES.map(name => ({ name, open_jobs: jobs[name] || 0, professionals: pros[name] || 0 })) });
});

// Public live activity for the homepage: newest jobs and bids (first names only, no amounts per person).
router.get('/pulse', (_req, res) => {
  const jobs = db.prepare(`SELECT j.id, j.title, j.city, j.province, j.category, j.created_at AS at,
    (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS bids, (SELECT ROUND(AVG(bid_amount)) FROM applications a WHERE a.job_id = j.id) AS avg_bid, j.pay_unit
    FROM jobs j WHERE j.status = 'open' ORDER BY j.id DESC LIMIT 6`).all().map(j => ({ kind: 'job', ...j }));
  const bids = db.prepare(`SELECT a.created_at AS at, u.name, p.avatar_color, j.id AS job_id, j.title, j.city FROM applications a
    JOIN users u ON u.id = a.user_id LEFT JOIN profiles p ON p.user_id = u.id JOIN jobs j ON j.id = a.job_id
    WHERE j.status = 'open' AND u.status = 'active' ORDER BY a.id DESC LIMIT 6`).all()
    .map(b => ({ kind: 'bid', ...b, name: b.name.split(' ')[0] + (b.name.split(' ')[1] ? ' ' + b.name.split(' ')[1][0] + '.' : '') }));
  res.json({ data: [...jobs, ...bids].sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, 6) });
});

module.exports = router;
