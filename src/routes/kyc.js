// Member-facing identity verification: details, documents, qualifications, bank account and submission.
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { HttpError, auth, requireRole, validate, z, PROVINCES } = require('../util');
const { UPLOAD_DIR, notify, audit } = require('../services');
const { encrypt, decrypt, encryptText, decryptText, blindHash, sha256 } = require('../vault');
const K = require('../kyc');
const { emit } = require('../events');

const KYC_DIR = path.join(UPLOAD_DIR, 'kyc');
fs.mkdirSync(KYC_DIR, { recursive: true });

const TYPES = {
  'image/jpeg': 'ffd8ff', 'image/png': '89504e47', 'image/webp': '52494646', 'application/pdf': '25504446',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '504b0304',
};
const KIND_TYPES = {
  selfie: ['image/jpeg', 'image/png', 'image/webp'],
  cv: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

router.use(auth());
router.use(requireRole('talent', 'client'));

const editable = (status) => ['none', 'draft', 'needs_info', 'rejected'].includes(status);
const assertEditable = (uid) => {
  const s = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(uid).kyc_status;
  if (!editable(s)) throw new HttpError(409, s === 'pending' ? 'Your verification is under review. You can make changes if we ask for more information.' : 'Your verification is approved. Contact support to change verified details.');
  if (s === 'none') db.prepare("UPDATE users SET kyc_status = 'draft' WHERE id = ?").run(uid);
};
function view(uid) {
  const s = K.state(uid);
  const k = s.kyc;
  return {
    status: s.status, complete: s.complete, requirements: s.requirements, docs: s.docs, qualifications: s.quals,
    bank: s.bank,
    details: k ? {
      account_type: k.account_type, legal_name: k.legal_name, id_type: k.id_type, id_number_masked: k.id_last4 ? '•••••••••' + k.id_last4 : '',
      id_country: k.id_country, dob: k.dob, nationality: k.nationality, phone: k.phone, address_line: k.address_line, suburb: k.suburb,
      city: k.city, province: k.province, postal_code: k.postal_code, is_pep: !!k.is_pep, pep_details: k.pep_details,
      source_of_funds: k.source_of_funds, business_name: k.business_name, business_reg: k.business_reg, business_role: k.business_role,
      submitted_at: k.submitted_at, reviewed_at: k.reviewed_at, review_note: k.review_note,
    } : null,
  };
}

router.get('/', (req, res) => res.json({ data: view(req.user.id) }));

router.put('/details', validate(z.object({
  account_type: z.enum(['individual', 'business']).default('individual'),
  legal_name: z.string().trim().min(3).max(120),
  id_type: z.enum(['sa_id', 'passport']),
  id_number: z.string().trim().max(30).optional(),
  id_country: z.string().trim().max(60).default('South Africa'),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').optional(),
  nationality: z.string().trim().min(2).max(60),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{9,20}$/, 'Enter a valid phone number'),
  address_line: z.string().trim().min(4).max(160),
  suburb: z.string().trim().max(80).default(''),
  city: z.string().trim().min(2).max(80),
  province: z.enum(PROVINCES),
  postal_code: z.string().trim().regex(/^\d{4}$/, 'A South African postal code has 4 digits'),
  is_pep: z.boolean(),
  pep_details: z.string().trim().max(500).default(''),
  source_of_funds: z.string().trim().max(300).default(''),
  business_name: z.string().trim().max(160).default(''),
  business_reg: z.string().trim().max(30).default(''),
  business_role: z.string().trim().max(80).default(''),
  consent: z.literal(true, { error: 'You must agree to the identity checks to continue' }),
})), (req, res) => {
  const uid = req.user.id, b = req.body;
  assertEditable(uid);
  const existing = db.prepare('SELECT * FROM kyc_profiles WHERE user_id = ?').get(uid);
  let dob = b.dob, idEnc = existing?.id_number_enc || '', idHash = existing?.id_number_hash || '', last4 = existing?.id_last4 || '';
  if (b.id_number) {
    const num = b.id_number.replace(/\s/g, '').toUpperCase();
    if (b.id_type === 'sa_id') {
      const p = K.parseSaId(num);
      if (!p.ok) throw new HttpError(400, p.error, [{ field: 'id_number', message: p.error }]);
      if (dob && dob !== p.dob) throw new HttpError(400, 'Your date of birth does not match your ID number', [{ field: 'dob', message: 'Does not match ID number' }]);
      dob = p.dob;
    } else if (!/^[A-Z0-9]{6,15}$/.test(num)) throw new HttpError(400, 'Enter the passport number as it appears on the passport', [{ field: 'id_number', message: 'Invalid passport number' }]);
    idEnc = encryptText(num); idHash = blindHash(b.id_type + ':' + num); last4 = num.slice(-4);
  }
  if (!last4) throw new HttpError(400, 'Enter your ID or passport number', [{ field: 'id_number', message: 'Required' }]);
  if (!dob) throw new HttpError(400, 'Enter your date of birth', [{ field: 'dob', message: 'Required' }]);
  if (K.ageOn(dob) < 18) throw new HttpError(400, 'You must be 18 or older to use TalentBridge');
  if (b.is_pep && b.pep_details.length < 5) throw new HttpError(400, 'Tell us your public position (for example, the office or role)', [{ field: 'pep_details', message: 'Required for politically exposed persons' }]);
  if (b.account_type === 'business' && (!b.business_name || !b.business_reg)) throw new HttpError(400, 'Enter the business name and registration number', [{ field: 'business_reg', message: 'Required' }]);
  if (b.account_type === 'business' && !/^\d{4}\/\d{6}\/\d{2}$/.test(b.business_reg)) throw new HttpError(400, 'Use the CIPC format, for example 2018/079316/07', [{ field: 'business_reg', message: 'Invalid format' }]);
  db.prepare(`INSERT INTO kyc_profiles (user_id, account_type, legal_name, id_type, id_number_enc, id_number_hash, id_last4, id_country, dob, nationality, phone,
      address_line, suburb, city, province, postal_code, is_pep, pep_details, source_of_funds, business_name, business_reg, business_role, consent_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET account_type=excluded.account_type, legal_name=excluded.legal_name, id_type=excluded.id_type, id_number_enc=excluded.id_number_enc,
      id_number_hash=excluded.id_number_hash, id_last4=excluded.id_last4, id_country=excluded.id_country, dob=excluded.dob, nationality=excluded.nationality, phone=excluded.phone,
      address_line=excluded.address_line, suburb=excluded.suburb, city=excluded.city, province=excluded.province, postal_code=excluded.postal_code, is_pep=excluded.is_pep,
      pep_details=excluded.pep_details, source_of_funds=excluded.source_of_funds, business_name=excluded.business_name, business_reg=excluded.business_reg,
      business_role=excluded.business_role, consent_at=datetime('now'), updated_at=datetime('now')`)
    .run(uid, b.account_type, b.legal_name, b.id_type, idEnc, idHash, last4, b.id_country, dob, b.nationality, b.phone, b.address_line, b.suburb, b.city, b.province,
      b.postal_code, b.is_pep ? 1 : 0, b.pep_details, b.source_of_funds, b.business_name, b.business_reg, b.business_role);
  // Residency follows the identity document: SA ID numbers show citizen or permanent resident; a passport means a foreign national.
  const saved = db.prepare('SELECT id_number_enc FROM kyc_profiles WHERE user_id = ?').get(uid);
  const residency = b.id_type === 'passport' ? 'foreign' : (K.parseSaId(decryptText(saved.id_number_enc)).citizen || 'citizen');
  db.prepare("UPDATE profiles SET residency = ?, nationality = ?, work_rights = CASE WHEN ? = 'foreign' THEN work_rights ELSE 'yes' END WHERE user_id = ?").run(residency, b.nationality, residency, uid);
  res.json({ data: view(uid) });
});

// Upload one document. Files are checked by their real content, hashed, encrypted and only then written to disk.
router.post('/documents', upload.single('file'), (req, res) => {
  const uid = req.user.id;
  assertEditable(uid);
  const kind = String(req.body?.kind || '');
  const allowed = ['id_front', 'id_back', 'proof_of_address', 'selfie', 'company_reg', 'qualification', 'work_permit', ...(req.user.role === 'talent' ? ['cv', 'saqa'] : [])];
  if (!allowed.includes(kind)) throw new HttpError(400, 'Choose what this document is');
  const f = req.file;
  if (!f) throw new HttpError(400, 'Choose a file to upload');
  const types = KIND_TYPES[kind] || ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (!types.includes(f.mimetype)) throw new HttpError(400, kind === 'selfie' ? 'The selfie must be a photo (JPG, PNG or WebP)' : kind === 'cv' ? 'Upload your CV as a PDF or Word document' : 'Upload a photo or PDF (JPG, PNG, WebP or PDF)');
  if (!f.buffer.subarray(0, 4).toString('hex').startsWith(TYPES[f.mimetype])) throw new HttpError(400, 'That file does not look like the type it claims to be');
  if (f.size < 10 * 1024 && kind !== 'cv') throw new HttpError(400, 'That file is too small to read clearly. Upload a sharper photo or scan');
  let qid = null;
  if (kind === 'qualification') {
    qid = Number(req.body.qualification_id);
    if (!db.prepare('SELECT 1 FROM qualifications WHERE id = ? AND user_id = ?').get(qid, uid)) throw new HttpError(404, 'Add the qualification first, then upload its certificate');
  }
  const hash = sha256(f.buffer);
  const name = crypto.randomBytes(16).toString('hex') + '.bin';
  fs.writeFileSync(path.join(KYC_DIR, name), encrypt(f.buffer), { mode: 0o600 });
  db.transaction(() => {
    // One current file per kind (per qualification for certificates); older ones are kept as "replaced" for the audit trail.
    db.prepare(`UPDATE kyc_documents SET status = 'replaced' WHERE user_id = ? AND kind = ? AND IFNULL(qualification_id,0) = ? AND status != 'replaced'`).run(uid, kind, qid || 0);
    db.prepare('INSERT INTO kyc_documents (user_id, kind, qualification_id, file_path, file_name, mime, size, sha256) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid, kind, qid, name, f.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 120), f.mimetype, f.size, hash);
  })();
  res.status(201).json({ data: view(uid) });
});

router.get('/documents/:id/file', (req, res) => {
  const d = db.prepare('SELECT * FROM kyc_documents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!d) throw new HttpError(404, 'Document not found');
  sendDoc(res, d);
});
function sendDoc(res, d) {
  const buf = decrypt(fs.readFileSync(path.join(KYC_DIR, path.basename(d.file_path))));
  res.set({ 'Content-Type': d.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${d.file_name.replace(/"/g, '')}"` });
  res.send(buf);
}

router.post('/qualifications', validate(z.object({
  institution: z.string().trim().min(2).max(160), qualification: z.string().trim().min(2).max(160),
  field: z.string().trim().max(120).default(''), year: z.number().int().min(1950).max(new Date().getFullYear() + 1),
  student_number: z.string().trim().max(40).default(''), certificate_number: z.string().trim().max(60).default(''),
  institution_contact: z.string().trim().max(200).default(''),
  consent_to_contact: z.literal(true, { error: 'We need your permission to confirm this qualification with the institution' }),
})), (req, res) => {
  if (req.user.role !== 'talent') throw new HttpError(403, 'Only professionals add qualifications');
  assertEditable(req.user.id);
  if (db.prepare('SELECT COUNT(*) n FROM qualifications WHERE user_id = ?').get(req.user.id).n >= 10) throw new HttpError(400, 'You can add up to 10 qualifications');
  const b = req.body;
  const id = db.prepare('INSERT INTO qualifications (user_id, institution, qualification, field, year, student_number, certificate_number, institution_contact, consent_to_contact) VALUES (?,?,?,?,?,?,?,?,1)')
    .run(req.user.id, b.institution, b.qualification, b.field, b.year, b.student_number, b.certificate_number, b.institution_contact).lastInsertRowid;
  res.status(201).json({ data: { id, ...view(req.user.id) } });
});
router.delete('/qualifications/:id', (req, res) => {
  assertEditable(req.user.id);
  const q = db.prepare('SELECT * FROM qualifications WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!q) throw new HttpError(404, 'Qualification not found');
  if (q.status === 'verified') throw new HttpError(409, 'Verified qualifications cannot be removed here. Contact support');
  db.transaction(() => {
    db.prepare("UPDATE kyc_documents SET status = 'replaced' WHERE user_id = ? AND qualification_id = ?").run(req.user.id, q.id);
    db.prepare('DELETE FROM qualifications WHERE id = ?').run(q.id);
  })();
  res.json({ data: view(req.user.id) });
});

// Bank details can change after approval, but payouts are held for 72 hours and admins are alerted.
router.put('/bank', validate(z.object({
  holder: z.string().trim().min(3).max(120), bank: z.string().trim().min(2).max(60),
  account_number: z.string().trim().regex(/^\d{6,16}$/, 'Enter the account number using digits only'),
  branch_code: z.string().trim().regex(/^\d{6}$/, 'Branch codes have 6 digits'),
  account_type: z.enum(['cheque', 'savings', 'transmission', 'business']),
})), (req, res) => {
  const uid = req.user.id, b = req.body;
  const prev = db.prepare('SELECT account_hash FROM bank_accounts WHERE user_id = ?').get(uid);
  const hash = blindHash('bank:' + b.account_number);
  db.prepare(`INSERT INTO bank_accounts (user_id, holder, bank, account_enc, account_hash, account_last4, branch_code, account_type, changed_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET holder=excluded.holder, bank=excluded.bank, account_enc=excluded.account_enc, account_hash=excluded.account_hash,
      account_last4=excluded.account_last4, branch_code=excluded.branch_code, account_type=excluded.account_type,
      changed_at=CASE WHEN bank_accounts.account_hash = excluded.account_hash THEN bank_accounts.changed_at ELSE datetime('now') END`)
    .run(uid, b.holder, b.bank, encryptText(b.account_number), hash, b.account_number.slice(-4), b.branch_code, b.account_type);
  if (prev && prev.account_hash !== hash) {
    audit(uid, 'bank.changed', uid, { last4: b.account_number.slice(-4) });
    notify(uid, 'security', `Your payout bank account was changed to one ending ${b.account_number.slice(-4)}. If this wasn't you, contact support now. Payouts are held for ${K.BANK_CHANGE_HOLD_HOURS} hours.`, '#verify');
    if (db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(uid).kyc_status === 'approved') K.flag(uid, 'bank_changed', 'low', `Bank account changed to •••${b.account_number.slice(-4)}`);
  }
  K.runChecks(uid);
  res.json({ data: view(uid) });
});

router.post('/submit', (req, res) => {
  const uid = req.user.id;
  const s = K.state(uid);
  if (!editable(s.status)) throw new HttpError(409, 'Your verification has already been submitted');
  const missing = s.requirements.filter(r => !r.done && !r.optional).map(r => r.label);
  if (missing.length) throw new HttpError(400, `Still needed: ${missing.join(', ')}`);
  db.transaction(() => {
    db.prepare("UPDATE users SET kyc_status = 'pending' WHERE id = ?").run(uid);
    db.prepare("UPDATE kyc_profiles SET submitted_at = datetime('now') WHERE user_id = ?").run(uid);
  })();
  K.runChecks(uid);
  audit(uid, 'kyc.submitted', uid);
  const name = db.prepare('SELECT name FROM users WHERE id = ?').get(uid).name;
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all()) notify(a.id, 'kyc', `${name} submitted identity verification for review.`, `#admin/kyc/${uid}`, uid);
  res.json({ data: view(uid) });
});

module.exports = router;
module.exports.sendDoc = sendDoc;
module.exports.KYC_DIR = KYC_DIR;
