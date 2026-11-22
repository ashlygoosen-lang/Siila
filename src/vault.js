// Encryption at rest for identity data: AES-256-GCM for files and sensitive fields,
// and keyed hashes (HMAC-SHA256) so duplicates can be found without storing numbers in clear.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';

// DATA_KEY: 32 bytes as 64 hex characters or base64. If missing, a key is generated once and kept
// beside the database (on the persistent volume). Back it up: without it, stored documents cannot be read.
function loadKey() {
  const env = process.env.DATA_KEY;
  if (env) {
    const buf = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, 'hex') : Buffer.from(env, 'base64');
    if (buf.length === 32) return buf;
    console.warn('WARNING: DATA_KEY must be 32 bytes (64 hex characters). Falling back to the stored key.');
  }
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'siira.db');
  if (dbPath === ':memory:') return crypto.createHash('sha256').update('talentbridge-test-key').digest();
  const file = path.join(path.dirname(dbPath), '.data_key');
  try {
    if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    if (isProd) console.warn(`DATA_KEY was not set. Generated an encryption key at ${file}. Back it up and set DATA_KEY.`);
    return key;
  } catch (e) {
    throw new Error('Could not load or create the data encryption key: ' + e.message);
  }
}
const KEY = loadKey();
const HKEY = crypto.createHmac('sha256', KEY).update('talentbridge-hash-key').digest();

// Layout: [1 byte version][12 bytes IV][16 bytes tag][ciphertext]
function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const out = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), out]);
}
function decrypt(buf) {
  if (buf[0] !== 1) throw new Error('Unknown encryption format');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(1, 13));
  d.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([d.update(buf.subarray(29)), d.final()]);
}
const encryptText = (s) => (s ? encrypt(Buffer.from(String(s), 'utf8')).toString('base64') : '');
const decryptText = (s) => (s ? decrypt(Buffer.from(s, 'base64')).toString('utf8') : '');
// Normalised keyed hash: spaces and dashes removed, upper-case.
const blindHash = (s) => crypto.createHmac('sha256', HKEY).update(String(s).replace(/[\s-]/g, '').toUpperCase()).digest('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { encrypt, decrypt, encryptText, decryptText, blindHash, sha256 };
