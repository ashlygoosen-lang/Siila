// International talent and work-visa sponsorship rules.
// A long-term job is first open only to South African citizens and permanent residents (and foreign nationals who already
// have the right to work here). After SPONSOR_WAIT_DAYS with no suitable local hire, the client may ask TalentBridge to open
// it to foreign nationals. The client is the employer and the visa sponsor; TalentBridge introduces candidates and tracks the case.
const db = require('./db');
const { byOfo } = require('./skills');

const WAIT_DAYS = Math.max(0, Number(process.env.SPONSOR_WAIT_DAYS ?? 90));
const MIN_MONTHS = 12;

const isLongTerm = (j) => j.type === 'Full-Time' && (j.contract_term === 'permanent' || (j.contract_term === 'fixed' && (j.duration_months || 0) >= MIN_MONTHS));
const daysOpen = (j) => Math.floor((Date.now() - new Date(j.created_at.replace(' ', 'T') + 'Z').getTime()) / 864e5);
const routeFor = (ofo) => (byOfo(ofo) ? 'critical_skills' : 'general_work');
const ROUTE_LABEL = { critical_skills: 'Critical Skills Work Visa', general_work: 'General Work Visa' };

// Does this member need a work visa to work in South Africa?
function needsSponsorship(uid) {
  const p = db.prepare('SELECT residency, work_rights FROM profiles WHERE user_id = ?').get(uid);
  return !!p && p.residency === 'foreign' && p.work_rights !== 'yes';
}

// Can this professional bid on this job?
function canBid(uid, j) {
  if (!needsSponsorship(uid)) return { ok: true };
  if (j.intl_status === 'approved') return { ok: true };
  if (j.remote) return { ok: true }; // remote work done from outside South Africa does not need a South African work visa
  return { ok: false, reason: 'This job is open to South African citizens and permanent residents for now. You can bid on remote jobs, and on jobs opened to international applicants.' };
}

// Can the client ask to open this job to foreign nationals? Returns the checks so the UI can explain what's missing.
function eligibility(j) {
  const client = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(j.client_id);
  const days = daysOpen(j);
  const hired = db.prepare("SELECT COUNT(*) n FROM applications WHERE job_id = ? AND status = 'hired'").get(j.id).n;
  const checks = [
    { key: 'long_term', ok: isLongTerm(j), label: 'Full-time job, permanent or a fixed term of 12 months or more' },
    { key: 'open', ok: j.status === 'open', label: 'Job is still open' },
    { key: 'wait', ok: days >= WAIT_DAYS, label: `Advertised to South Africans for at least ${WAIT_DAYS} days (${Math.min(days, WAIT_DAYS)} so far)` },
    { key: 'kyc', ok: client?.kyc_status === 'approved', label: 'Your identity (and business) is verified' },
    { key: 'not_hired', ok: hired === 0, label: 'Nobody has been hired for it yet' },
  ];
  return { eligible: checks.every(c => c.ok), checks, days_open: days, days_left: Math.max(0, WAIT_DAYS - days), wait_days: WAIT_DAYS, status: j.intl_status,
    route: j.occupation_ofo ? routeFor(j.occupation_ofo) : null };
}

const intlBadge = (j) => (j.intl_status === 'approved' ? { open_to_international: true, visa_route: j.occupation_ofo ? routeFor(j.occupation_ofo) : 'general_work' } : { open_to_international: false });

// Documents the visa application usually needs. The visa agent confirms the exact list for each case.
const CHECKLIST = {
  critical_skills: [
    'Passport valid for at least 30 days after the intended stay, with 2 blank pages',
    'Signed offer or contract of employment in the critical skill',
    'Qualifications evaluated by SAQA',
    'Registration with, or confirmation from, the professional body for the occupation',
    'CV and letters confirming at least the required experience',
    'Police clearance from every country lived in for 12 months or more since age 18',
    'Medical and radiological (chest X-ray) reports, not older than 6 months',
    'Proof of financial means, or the employer’s undertaking',
  ],
  general_work: [
    'Passport valid for at least 30 days after the intended stay, with 2 blank pages',
    'Signed contract of employment on terms at least equal to South African labour standards',
    'Points under the points-based system (100 or more), or a recommendation from the Department of Employment and Labour that no suitable citizen or permanent resident was found',
    'Qualifications evaluated by SAQA',
    'Employer undertakings (to keep the passport valid, to notify Home Affairs if employment ends, and to pay repatriation costs if required)',
    'Police clearance from every country lived in for 12 months or more since age 18',
    'Medical and radiological (chest X-ray) reports, not older than 6 months',
  ],
};
const STEPS = ['offered', 'accepted', 'documents', 'submitted', 'approved', 'arrived'];
const STEP_LABEL = { offered: 'Job offered', accepted: 'Offer accepted', declined: 'Offer declined', withdrawn: 'Offer withdrawn', documents: 'Collecting documents', submitted: 'Visa application submitted', approved: 'Visa approved', refused: 'Visa refused', arrived: 'Started work in South Africa', closed: 'Closed' };

module.exports = { WAIT_DAYS, MIN_MONTHS, isLongTerm, daysOpen, routeFor, ROUTE_LABEL, needsSponsorship, canBid, eligibility, intlBadge, CHECKLIST, STEPS, STEP_LABEL };
