// Identity verification (KYC) rules, fraud/AML risk checks and gates.
const db = require('./db');
const { HttpError } = require('./util');

const HIGH_VALUE_CENTS = Number(process.env.AML_REVIEW_THRESHOLD || 50000) * 100; // contracts at or above this are reviewed
const BANK_CHANGE_HOLD_HOURS = 72;

// ---- South African ID number: YYMMDD SSSS C A Z (13 digits, Luhn check digit) ----
function parseSaId(raw) {
  const id = String(raw || '').replace(/\s/g, '');
  if (!/^\d{13}$/.test(id)) return { ok: false, error: 'A South African ID number has 13 digits' };
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = Number(id[12 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  if (sum % 10 !== 0) return { ok: false, error: 'That ID number is not valid. Check the digits' };
  const yy = Number(id.slice(0, 2)), mm = Number(id.slice(2, 4)), dd = Number(id.slice(4, 6));
  const now = new Date(), century = yy > now.getFullYear() % 100 ? 1900 : 2000;
  const dob = new Date(Date.UTC(century + yy, mm - 1, dd));
  if (dob.getUTCMonth() !== mm - 1 || dob.getUTCDate() !== dd) return { ok: false, error: 'That ID number has an invalid date of birth' };
  return {
    ok: true, dob: dob.toISOString().slice(0, 10),
    gender: Number(id.slice(6, 10)) >= 5000 ? 'male' : 'female',
    citizen: id[10] === '0' ? 'citizen' : 'permanent_resident',
  };
}
const ageOn = (dobIso, at = new Date()) => {
  const d = new Date(dobIso + 'T00:00:00Z');
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  if (at.getUTCMonth() < d.getUTCMonth() || (at.getUTCMonth() === d.getUTCMonth() && at.getUTCDate() < d.getUTCDate())) a--;
  return a;
};

// ---- What each account must provide ----
function requirements(user, kyc, prof = {}) {
  const foreign = prof.residency === 'foreign' || kyc?.id_type === 'passport';
  const req = [
    { key: 'details', label: 'Personal details' },
    { key: 'id_front', label: kyc?.id_type === 'passport' ? 'Passport photo page' : 'ID document (front)', doc: true },
    { key: 'proof_of_address', label: 'Proof of address (not older than 3 months)', doc: true },
    { key: 'selfie', label: 'Selfie holding your ID', doc: true },
  ];
  if (kyc?.id_type !== 'passport') req.splice(2, 0, { key: 'id_back', label: 'ID document (back, for smart ID cards)', doc: true, optional: true });
  if (kyc?.account_type === 'business') req.push({ key: 'company_reg', label: 'Company registration document (CIPC)', doc: true });
  if (foreign && prof.work_rights === 'yes') req.push({ key: 'work_permit', label: 'South African visa or permit that allows you to work', doc: true });
  if (user.role === 'talent') {
    // Foreign professionals who still need a work visa are hired as employees, so a South African payout account is optional until they arrive.
    req.push({ key: 'bank', label: 'Bank account for payouts', optional: foreign && prof.work_rights !== 'yes' });
    req.push({ key: 'cv', label: 'CV', doc: true });
    req.push({ key: 'qualifications', label: 'Qualifications (at least one, with certificate)', optional: false });
    if (foreign) req.push({ key: 'saqa', label: 'SAQA evaluation certificate for foreign qualifications', doc: true, optional: true });
  }
  return req;
}

function state(userId) {
  const user = db.prepare('SELECT id, name, role, kyc_status FROM users WHERE id = ?').get(userId);
  const kyc = db.prepare('SELECT * FROM kyc_profiles WHERE user_id = ?').get(userId) || null;
  const docs = db.prepare("SELECT id, kind, qualification_id, file_name, mime, size, status, note, uploaded_at FROM kyc_documents WHERE user_id = ? AND status != 'replaced' ORDER BY id").all(userId);
  const quals = db.prepare('SELECT id, institution, qualification, field, year, student_number, certificate_number, institution_contact, consent_to_contact, status, verify_method, verify_reference, verified_at, verify_note FROM qualifications WHERE user_id = ? ORDER BY id').all(userId);
  const bank = db.prepare('SELECT holder, bank, account_last4, branch_code, account_type, changed_at FROM bank_accounts WHERE user_id = ?').get(userId) || null;
  const have = (k) => docs.some(d => d.kind === k && d.status !== 'rejected');
  const detailsDone = !!(kyc && kyc.legal_name && kyc.id_last4 && kyc.dob && kyc.address_line && kyc.city && kyc.postal_code && kyc.phone && kyc.consent_at
    && (kyc.account_type !== 'business' || (kyc.business_name && kyc.business_reg)));
  const prof = db.prepare('SELECT residency, work_rights FROM profiles WHERE user_id = ?').get(userId) || {};
  const reqs = requirements(user, kyc, prof).map(r => {
    let done;
    if (r.key === 'details') done = detailsDone;
    else if (r.key === 'bank') done = !!bank;
    else if (r.key === 'qualifications') done = quals.length > 0 && quals.every(q => docs.some(d => d.kind === 'qualification' && d.qualification_id === q.id && d.status !== 'rejected'));
    else done = have(r.key);
    return { ...r, done };
  });
  const complete = reqs.every(r => r.done || r.optional);
  return { user, kyc, docs, quals, bank, requirements: reqs, complete, status: user.kyc_status };
}

// ---- Risk engine: records flags; never blocks silently ----
function flag(userId, kind, severity, detail, contractId = null) {
  db.prepare('INSERT OR IGNORE INTO risk_flags (user_id, contract_id, kind, severity, detail) VALUES (?,?,?,?,?)').run(userId, contractId, kind, severity, detail);
}
function runChecks(userId) {
  const k = db.prepare('SELECT * FROM kyc_profiles WHERE user_id = ?').get(userId);
  if (k?.id_number_hash) {
    const others = db.prepare('SELECT user_id FROM kyc_profiles WHERE id_number_hash = ? AND user_id != ?').all(k.id_number_hash, userId);
    for (const o of others) flag(userId, 'duplicate_id', 'high', `Same ID number as account #${o.user_id}`);
  }
  if (k?.dob && ageOn(k.dob) < 18) flag(userId, 'underage', 'high', 'Date of birth shows the person is under 18');
  if (k?.is_pep) flag(userId, 'pep', 'medium', 'Declared a politically exposed person: enhanced due diligence required');
  const docs = db.prepare("SELECT sha256 FROM kyc_documents WHERE user_id = ? AND status != 'replaced'").all(userId);
  for (const d of docs) {
    const dup = db.prepare("SELECT DISTINCT user_id FROM kyc_documents WHERE sha256 = ? AND user_id != ? AND status != 'replaced'").all(d.sha256, userId);
    for (const o of dup) flag(userId, 'duplicate_document', 'high', `Uploaded a file identical to one on account #${o.user_id}`);
  }
  const b = db.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').get(userId);
  if (b) {
    const others = db.prepare('SELECT user_id FROM bank_accounts WHERE account_hash = ? AND user_id != ?').all(b.account_hash, userId);
    for (const o of others) flag(userId, 'duplicate_bank', 'high', `Same bank account as account #${o.user_id}`);
    if (k?.legal_name && !namesMatch(b.holder, k.account_type === 'business' ? k.business_name : k.legal_name) && !namesMatch(b.holder, k.legal_name))
      flag(userId, 'bank_name_mismatch', 'medium', `Account holder "${b.holder}" does not match "${k.legal_name}"`);
  }
}
function namesMatch(a, b) {
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const A = words(a), B = new Set(words(b));
  if (!A.length || !B.size) return false;
  return A.filter(w => B.has(w)).length >= Math.min(2, A.length, B.size);
}
// Self-dealing: client and professional on a contract share an ID number or bank account.
function checkContract(c) {
  const ids = db.prepare('SELECT user_id, id_number_hash FROM kyc_profiles WHERE user_id IN (?,?)').all(c.client_id, c.talent_id);
  if (ids.length === 2 && ids[0].id_number_hash && ids[0].id_number_hash === ids[1].id_number_hash)
    flag(c.talent_id, 'self_dealing', 'high', `Client and professional on contract #${c.id} have the same ID number`, c.id);
  const banks = db.prepare('SELECT account_hash FROM bank_accounts WHERE user_id IN (?,?)').all(c.client_id, c.talent_id);
  if (banks.length === 2 && banks[0].account_hash === banks[1].account_hash)
    flag(c.talent_id, 'self_dealing', 'high', `Client and professional on contract #${c.id} use the same bank account`, c.id);
  if (c.amount_cents >= HIGH_VALUE_CENTS) {
    flag(c.client_id, 'high_value', 'medium', `Contract #${c.id} of R${(c.amount_cents / 100).toLocaleString('en-ZA')} needs an AML review before payout`, c.id);
    db.prepare('UPDATE contracts SET aml_hold = 1 WHERE id = ?').run(c.id);
  }
}

// ---- Gates ----
function requireVerified(userId, action) {
  const u = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(userId);
  if (process.env.KYC_REQUIRED === 'false') return;
  if (u?.kyc_status !== 'approved') {
    throw new HttpError(403, `Verify your identity before you ${action}. Go to Verification in your dashboard.`, [{ field: 'kyc', message: 'kyc_required' }]);
  }
}
// Reasons a payout must wait. Empty list means it may go ahead.
function payoutBlockers(contract) {
  const out = [];
  const t = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(contract.talent_id);
  if (t?.kyc_status !== 'approved') out.push('The professional is not verified');
  const b = db.prepare('SELECT changed_at FROM bank_accounts WHERE user_id = ?').get(contract.talent_id);
  if (!b) out.push('The professional has no bank account on file');
  else if ((Date.now() - new Date(b.changed_at.replace(' ', 'T') + 'Z')) / 36e5 < BANK_CHANGE_HOLD_HOURS) out.push(`Bank details changed less than ${BANK_CHANGE_HOLD_HOURS} hours ago`);
  if (contract.aml_hold) out.push('Contract is waiting for an AML review');
  const flags = db.prepare("SELECT kind FROM risk_flags WHERE status = 'open' AND severity = 'high' AND (user_id IN (?,?) OR contract_id = ?)").all(contract.client_id, contract.talent_id, contract.id);
  if (flags.length) out.push(`Open high-risk flags: ${[...new Set(flags.map(f => f.kind))].join(', ')}`);
  return out;
}

module.exports = { parseSaId, ageOn, requirements, state, runChecks, checkContract, flag, requireVerified, payoutBlockers, namesMatch, HIGH_VALUE_CENTS, BANK_CHANGE_HOLD_HOURS };
