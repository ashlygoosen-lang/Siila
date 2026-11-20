const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { validate, z } = require('../util');
const { company } = require('../services');
const { sendMail } = require('../mailer');

router.get('/config', (_req, res) => res.json({ company: company(), draft: !process.env.COMPANY_NAME }));

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many messages, please try again later' } });
router.post('/contact', limiter, validate(z.object({
  name: z.string().trim().min(2).max(80), email: z.email(), topic: z.enum(['General', 'Hiring', 'Finding work', 'Payments', 'Verification', 'Privacy request']).default('General'),
  message: z.string().trim().min(10).max(3000), website: z.string().max(200).optional(), // honeypot
})), (req, res) => {
  if (req.body.website) return res.status(201).json({ ok: true }); // bot
  const { name, email, topic, message } = req.body;
  db.prepare('INSERT INTO contact_messages (name,email,topic,message) VALUES (?,?,?,?)').run(name, email, topic, message);
  sendMail(process.env.SUPPORT_EMAIL, `SIIRA enquiry: ${topic}`, `From: ${name} <${email}>\n\n${message}`);
  res.status(201).json({ ok: true });
});
module.exports = router;
