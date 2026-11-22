// PayFast (South Africa) custom integration: signed checkout redirect + verified ITN (Instant Transaction Notification).
// Every ITN must pass four checks before money is treated as received:
//   1. signature matches, 2. request comes from a PayFast server, 3. amount matches what we asked for,
//   4. PayFast confirms the data itself (server-to-server "validate" call).
const crypto = require('crypto');
const dns = require('dns').promises;

const isSandbox = () => process.env.PAYFAST_SANDBOX !== 'false';
const host = () => (isSandbox() ? 'sandbox.payfast.co.za' : 'www.payfast.co.za');

// PayFast's shared public sandbox account is used when no merchant details are set (sandbox only).
function creds() {
  if (process.env.PAYFAST_MERCHANT_ID) return { id: process.env.PAYFAST_MERCHANT_ID, key: process.env.PAYFAST_MERCHANT_KEY || '', pass: process.env.PAYFAST_PASSPHRASE || '' };
  if (isSandbox()) return { id: '10000100', key: '46f0cd694581a', pass: process.env.PAYFAST_PASSPHRASE ?? 'jt7NOE43FZPn' };
  return null;
}
const configured = () => !!creds() && (isSandbox() || (!!process.env.PAYFAST_MERCHANT_KEY && !!process.env.PAYFAST_PASSPHRASE));

// Same encoding as PHP urlencode(): spaces become "+", hex in upper case, only A-Z a-z 0-9 - _ . left as is.
const enc = (v) => encodeURIComponent(String(v)).replace(/%20/g, '+').replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// Checkout signature: non-empty fields in the order they are sent, trimmed, then the passphrase.
function checkoutSignature(fields, pass) {
  const s = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '').map(([k, v]) => `${k}=${enc(String(v).trim())}`).join('&');
  return md5(pass ? `${s}&passphrase=${enc(pass.trim())}` : s);
}

/** Build the form PayFast expects. The browser posts it to PayFast's payment page. */
function checkout({ reference, amountCents, itemName, itemDescription, buyer, contractId, baseUrl }) {
  const c = creds();
  if (!c) throw new Error('PayFast is not configured');
  const fields = {
    merchant_id: c.id, merchant_key: c.key,
    return_url: `${baseUrl}/app.html?payment=return#contracts/${contractId}`,
    cancel_url: `${baseUrl}/app.html?payment=cancelled#contracts/${contractId}`,
    notify_url: `${baseUrl}/api/webhooks/payfast`,
    name_first: (buyer.first || '').slice(0, 100), name_last: (buyer.last || '').slice(0, 100), email_address: (buyer.email || '').slice(0, 100),
    m_payment_id: reference, amount: (amountCents / 100).toFixed(2),
    item_name: itemName.slice(0, 100), item_description: (itemDescription || '').slice(0, 255),
    custom_int1: String(contractId),
  };
  for (const k of Object.keys(fields)) if (fields[k] === '') delete fields[k];
  fields.signature = checkoutSignature(fields, c.pass);
  return { action: `https://${host()}/eng/process`, fields, sandbox: isSandbox() };
}

/** Parse an urlencoded body keeping the order PayFast sent the fields in. */
function parseOrdered(raw) {
  return String(raw || '').split('&').filter(Boolean).map(p => {
    const i = p.indexOf('=');
    const k = decodeURIComponent((i < 0 ? p : p.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' '));
    return [k, v];
  });
}
// ITN signature: every posted field except "signature" (empty ones included), as posted, then the passphrase.
function itnParamString(pairs) { return pairs.filter(([k]) => k !== 'signature').map(([k, v]) => `${k}=${enc(v)}`).join('&'); }

const PF_HOSTS = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];
async function fromPayFast(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '');
  const ips = new Set();
  for (const h of PF_HOSTS) { try { (await dns.resolve4(h)).forEach(a => ips.add(a)); } catch { /* host may not resolve */ } }
  return ips.has(clean);
}
async function confirmWithPayFast(paramString) {
  const r = await fetch(`https://${host()}/eng/query/validate`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: paramString, signal: AbortSignal.timeout(15000) });
  return (await r.text()).trim() === 'VALID';
}

/**
 * Verify an ITN. Returns { ok, data, reason }.
 * Checks 2 and 4 need the internet; they can only be switched off in automated tests (NODE_ENV=test).
 */
async function verifyItn(rawBody, ip) {
  const c = creds();
  if (!c) return { ok: false, reason: 'not_configured' };
  const pairs = parseOrdered(rawBody);
  const data = Object.fromEntries(pairs);
  const base = itnParamString(pairs);
  const expected = md5(c.pass ? `${base}&passphrase=${enc(c.pass.trim())}` : base);
  const got = String(data.signature || '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return { ok: false, data, reason: 'bad_signature' };
  if (data.merchant_id !== c.id) return { ok: false, data, reason: 'wrong_merchant' };
  const testing = process.env.NODE_ENV === 'test';
  if (!(testing && process.env.PAYFAST_SKIP_IP_CHECK === 'true') && !(await fromPayFast(ip))) return { ok: false, data, reason: 'bad_source' };
  if (!(testing && process.env.PAYFAST_SKIP_VALIDATE === 'true')) {
    let valid = false;
    try { valid = await confirmWithPayFast(base); } catch { valid = false; }
    if (!valid) return { ok: false, data, reason: 'not_confirmed' };
  }
  return { ok: true, data };
}

module.exports = { checkout, verifyItn, configured, isSandbox, creds, checkoutSignature, itnParamString, parseOrdered, enc, md5, host };
