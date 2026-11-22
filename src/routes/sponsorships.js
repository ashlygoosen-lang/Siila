// Work-visa sponsorship: the client (employer) offers a long-term job to a foreign professional; the visa case is tracked here.
const router = require('express').Router();
const admin = require('express').Router();
const db = require('../db');
const { HttpError, auth, requireRole, validate, z } = require('../util');
const { notify, audit, getOrCreateConversation, postMessage } = require('../services');
const SP = require('../sponsor');
const { byOfo } = require('../skills');

const AGENT = {
  name: process.env.VISA_AGENT_NAME || 'GlobalPath Immigration',
  url: process.env.VISA_AGENT_URL || 'https://globalpath-production.up.railway.app',
  fee: Number(process.env.VISA_AGENT_FEE ?? 10000),
  note: 'GlobalPath Immigration is a division of VINK Group (Pty) Ltd, like TalentBridge. Using it is optional; the employer may use any registered immigration practitioner.',
};

const SELECT = `SELECT s.*, j.title AS job_title, j.city, j.province, c.name AS client_name, t.name AS talent_name, p.nationality, p.country
  FROM sponsorships s JOIN jobs j ON j.id = s.job_id JOIN users c ON c.id = s.client_id JOIN users t ON t.id = s.talent_id LEFT JOIN profiles p ON p.user_id = s.talent_id`;
const shape = (s) => ({ ...s, use_agent: !!s.use_agent, route_label: SP.ROUTE_LABEL[s.route], occupation: byOfo(s.occupation_ofo)?.name || '', status_label: SP.STEP_LABEL[s.status],
  checklist: SP.CHECKLIST[s.route], steps: SP.STEPS, events: db.prepare('SELECT e.status, e.note, e.created_at, u.name AS actor FROM sponsorship_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.sponsorship_id = ? ORDER BY e.id').all(s.id) });
const load = (id) => { const s = db.prepare(SELECT + ' WHERE s.id = ?').get(id); if (!s) throw new HttpError(404, 'Sponsorship not found'); return s; };
const event = (id, actor, status, note = '') => {
  db.prepare("UPDATE sponsorships SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  db.prepare('INSERT INTO sponsorship_events (sponsorship_id, actor_id, status, note) VALUES (?,?,?,?)').run(id, actor, status, note);
};

router.use(auth());
router.get('/agent', (_req, res) => res.json({ data: AGENT }));

router.get('/', (req, res) => {
  const rows = req.user.role === 'admin' ? db.prepare(SELECT + ' ORDER BY s.updated_at DESC LIMIT 300').all()
    : db.prepare(SELECT + ' WHERE s.client_id = ? OR s.talent_id = ? ORDER BY s.updated_at DESC').all(req.user.id, req.user.id);
  res.json({ data: rows.map(r => ({ ...r, route_label: SP.ROUTE_LABEL[r.route], status_label: SP.STEP_LABEL[r.status] })) });
});

router.get('/:id', (req, res) => {
  const s = load(req.params.id);
  if (req.user.role !== 'admin' && ![s.client_id, s.talent_id].includes(req.user.id)) throw new HttpError(403, 'This sponsorship belongs to other members');
  res.json({ data: { ...shape(s), agent: AGENT } });
});

// Client offers a sponsored job to a foreign applicant who bid on a job that is open to international applicants.
router.post('/', requireRole('client'), validate(z.object({
  application_id: z.number().int(),
  salary_annual: z.number().int().min(1000).max(100000000),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  terms: z.string().trim().min(20, 'Describe the main terms: role, hours, benefits and contract length').max(4000),
  use_agent: z.boolean().default(true),
  confirm: z.literal(true, { error: 'Confirm that you will employ the person and meet your duties as a visa sponsor' }),
})), (req, res) => {
  const b = req.body;
  const a = db.prepare('SELECT a.*, j.client_id, j.title, j.intl_status, j.occupation_ofo, j.status AS job_status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?').get(b.application_id);
  if (!a || a.client_id !== req.user.id) throw new HttpError(404, 'Bid not found');
  if (a.intl_status !== 'approved') throw new HttpError(409, 'This job is not open to international applicants');
  if (a.job_status !== 'open') throw new HttpError(409, 'This job is closed');
  if (!SP.needsSponsorship(a.user_id)) throw new HttpError(409, 'This professional doesn’t need a work visa. Hire them the usual way.');
  if (db.prepare("SELECT 1 FROM sponsorships WHERE job_id = ? AND talent_id = ? AND status NOT IN ('declined','withdrawn','refused','closed')").get(a.job_id, a.user_id)) throw new HttpError(409, 'You have already offered this job to this professional');
  if (db.prepare("SELECT kyc_status FROM users WHERE id = ?").get(a.user_id).kyc_status !== 'approved') throw new HttpError(409, 'This professional must finish identity verification before you can offer sponsorship');
  const route = SP.routeFor(a.occupation_ofo);
  const id = db.prepare('INSERT INTO sponsorships (job_id, application_id, client_id, talent_id, route, occupation_ofo, salary_annual, start_date, terms, use_agent) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(a.job_id, a.id, req.user.id, a.user_id, route, a.occupation_ofo || '', b.salary_annual, b.start_date || null, b.terms, b.use_agent ? 1 : 0).lastInsertRowid;
  db.prepare('INSERT INTO sponsorship_events (sponsorship_id, actor_id, status) VALUES (?,?,?)').run(id, req.user.id, 'offered');
  db.prepare("UPDATE applications SET status = 'shortlisted' WHERE id = ? AND status = 'submitted'").run(a.id);
  const conv = getOrCreateConversation(req.user.id, a.user_id, a.job_id);
  postMessage(conv, req.user.id, `I’d like to offer you this job with visa sponsorship: R${b.salary_annual.toLocaleString('en-ZA')} a year (${SP.ROUTE_LABEL[route]}). The full offer is under Sponsorship in your dashboard.`);
  notify(a.user_id, 'sponsorship', `You’ve been offered a sponsored job: "${a.title}". Review the offer.`, `#sponsorships/${id}`, req.user.id);
  audit(req.user.id, 'sponsorship.offered', id, { job: a.job_id, talent: a.user_id });
  res.status(201).json({ data: shape(load(id)) });
});

router.post('/:id/respond', requireRole('talent'), validate(z.object({ accept: z.boolean(), note: z.string().trim().max(1000).default('') })), (req, res) => {
  const s = load(req.params.id);
  if (s.talent_id !== req.user.id) throw new HttpError(403, 'This offer is for someone else');
  if (s.status !== 'offered') throw new HttpError(409, 'This offer has already been answered');
  event(s.id, req.user.id, req.body.accept ? 'accepted' : 'declined', req.body.note);
  if (req.body.accept) {
    db.prepare("UPDATE applications SET status = 'hired' WHERE id = ?").run(s.application_id);
    db.prepare("UPDATE jobs SET status = 'closed' WHERE id = ?").run(s.job_id);
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all()) notify(a.id, 'sponsorship', `${s.talent_name} accepted a sponsored job with ${s.client_name}. Start the visa case.`, '#admin/international', req.user.id);
  }
  notify(s.client_id, 'sponsorship', `${s.talent_name} ${req.body.accept ? 'accepted' : 'declined'} your sponsored job offer for "${s.job_title}".`, `#sponsorships/${s.id}`, req.user.id);
  res.json({ data: shape(load(s.id)) });
});

router.post('/:id/withdraw', requireRole('client'), validate(z.object({ note: z.string().trim().min(5).max(1000) })), (req, res) => {
  const s = load(req.params.id);
  if (s.client_id !== req.user.id) throw new HttpError(403, 'This offer belongs to another client');
  if (!['offered', 'accepted', 'documents'].includes(s.status)) throw new HttpError(409, 'The visa application is already submitted. Contact support to cancel.');
  event(s.id, req.user.id, 'withdrawn', req.body.note);
  notify(s.talent_id, 'sponsorship', `${s.client_name} withdrew the sponsored job offer for "${s.job_title}". ${req.body.note}`, `#sponsorships/${s.id}`, req.user.id);
  res.json({ data: shape(load(s.id)) });
});

// ---- Admin ----
admin.use(auth(), requireRole('admin'));
admin.get('/international', (_req, res) => {
  const jobs = db.prepare(`SELECT j.*, u.name AS client_name, u.email AS client_email, k.business_name, k.account_type,
      (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS bids
    FROM jobs j JOIN users u ON u.id = j.client_id LEFT JOIN kyc_profiles k ON k.user_id = j.client_id
    WHERE j.intl_status != 'none' ORDER BY CASE j.intl_status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, j.intl_requested_at DESC LIMIT 300`).all()
    .map(j => ({ ...j, occupation: byOfo(j.occupation_ofo)?.name || '', route_label: SP.ROUTE_LABEL[SP.routeFor(j.occupation_ofo)], days_open: SP.daysOpen(j), long_term: SP.isLongTerm(j) }));
  const cases = db.prepare(SELECT + ' ORDER BY s.updated_at DESC LIMIT 300').all().map(r => ({ ...r, route_label: SP.ROUTE_LABEL[r.route], status_label: SP.STEP_LABEL[r.status] }));
  res.json({ data: { jobs, cases } });
});

admin.post('/international/jobs/:id/decision', validate(z.object({ decision: z.enum(['approved', 'declined']), note: z.string().trim().max(1000).default('') })), (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!j) throw new HttpError(404, 'Job not found');
  if (j.intl_status !== 'requested') throw new HttpError(409, 'There is no open request for this job');
  if (req.body.decision === 'declined' && req.body.note.length < 5) throw new HttpError(400, 'Tell the client why the request was declined');
  if (req.body.decision === 'approved' && !SP.eligibility(j).eligible) throw new HttpError(409, 'The job no longer meets the requirements');
  db.prepare("UPDATE jobs SET intl_status = ?, intl_decided_at = datetime('now'), intl_decider_id = ?, intl_note = ? WHERE id = ?").run(req.body.decision, req.user.id, req.body.note, j.id);
  audit(req.user.id, 'international.' + req.body.decision, j.id, { note: req.body.note });
  notify(j.client_id, 'international', req.body.decision === 'approved' ? `"${j.title}" is now open to international applicants.` : `Your request to open "${j.title}" to international applicants was declined. ${req.body.note}`, `#job/${j.id}`, req.user.id);
  if (req.body.decision === 'approved') {
    // Alert foreign professionals in the same occupation or with matching skills.
    const words = j.title.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
    const like = words.length ? 'OR ' + words.map(() => '(LOWER(p.skills) LIKE ? OR LOWER(p.headline) LIKE ?)').join(' OR ') : '';
    const rows = db.prepare(`SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'talent' AND u.status = 'active' AND p.residency = 'foreign' AND p.work_rights != 'yes'
      AND ((p.occupation_ofo != '' AND p.occupation_ofo = ?) ${like}) LIMIT 100`).all(j.occupation_ofo || '-', ...words.flatMap(w => [`%${w}%`, `%${w}%`]));
    for (const r of rows) notify(r.id, 'job_match', `A South African employer is offering visa sponsorship: "${j.title}" in ${j.city}.`, `#job/${j.id}`, req.user.id);
  }
  res.json({ data: { id: j.id, intl_status: req.body.decision } });
});

admin.post('/sponsorships/:id/status', validate(z.object({ status: z.enum(['documents', 'submitted', 'approved', 'refused', 'arrived', 'closed']), reference: z.string().trim().max(120).default(''), note: z.string().trim().max(1000).default('') })), (req, res) => {
  const s = load(req.params.id);
  if (['offered', 'declined', 'withdrawn'].includes(s.status)) throw new HttpError(409, 'The professional must accept the offer first');
  if (req.body.status === 'submitted' && !req.body.reference && !s.reference) throw new HttpError(400, 'Enter the VFS or Home Affairs reference number');
  if (req.body.reference) db.prepare('UPDATE sponsorships SET reference = ? WHERE id = ?').run(req.body.reference, s.id);
  event(s.id, req.user.id, req.body.status, req.body.note);
  audit(req.user.id, 'sponsorship.' + req.body.status, s.id);
  const msg = `Visa case for "${s.job_title}": ${SP.STEP_LABEL[req.body.status]}.${req.body.note ? ' ' + req.body.note : ''}`;
  for (const uid of [s.client_id, s.talent_id]) notify(uid, 'sponsorship', msg, `#sponsorships/${s.id}`, req.user.id);
  res.json({ data: shape(load(s.id)) });
});

module.exports = { router, admin, AGENT };
