process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
const assert = require('node:assert/strict');
const app = require('../src/server');
const { outbox } = require('../src/mailer');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  const raw = async (url, token) => { const r = await fetch(base + url, { headers: { authorization: 'Bearer ' + token } }); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };
  const step = async (name, fn) => { await fn(); console.log('  ok  ' + name); };

  await step('health + meta', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal((await call('GET', '/meta')).body.provinces.length, 9);
  });
  await step('jobs list, filter and search', async () => {
    const all = await call('GET', '/jobs');
    assert.equal(all.body.meta.total, 8);
    assert.equal(all.body.data[0].pay_label.includes('R'), true);
    assert.equal((await call('GET', '/jobs?type=Freelance')).body.data.length, 2);
    assert.equal((await call('GET', '/jobs?q=plumber')).body.data.length, 1);
    assert.equal((await call('GET', '/jobs?type=Nope')).status, 400);
  });
  await step('talent list', async () => {
    const t = await call('GET', '/talent?province=Western%20Cape');
    assert.equal(t.body.data.length, 2);
  });
  let talentTok, clientTok, jobId;
  await step('register validation and duplicate email', async () => {
    assert.equal((await call('POST', '/auth/register', { name: 'A', email: 'bad', password: 'x', role: 'talent' })).status, 400);
    assert.equal((await call('POST', '/auth/register', { name: 'No Consent', email: 'nc@siira.test', password: 'Passw0rdOK', role: 'talent' })).status, 400); // POPIA consent required
    const r = await call('POST', '/auth/register', { name: 'Test Talent', email: 'new@siira.test', password: 'Passw0rdOK', role: 'talent', province: 'Gauteng', accept_terms: true });
    assert.equal(r.status, 201); talentTok = r.body.token;
    assert.equal((await call('POST', '/jobs/1/apply', {}, talentTok)).status, 403); // email not verified yet
    const mail = outbox.filter(m => m.to === 'new@siira.test').pop();
    const vt = mail.text.match(/token=([a-f0-9]+)/)[1];
    assert.equal((await fetch(base + '/auth/verify-email?token=' + vt, { redirect: 'manual' })).status, 302);
    assert.equal((await call('POST', '/auth/register', { name: 'Test Talent', email: 'NEW@siira.test', password: 'Passw0rdOK', role: 'talent', accept_terms: true })).status, 409);
  });
  await step('login (good and bad)', async () => {
    const ok = await call('POST', '/auth/login', { email: 'client@siira.test', password: 'Siira#2026' });
    assert.equal(ok.status, 200); clientTok = ok.body.token;
    assert.equal((await call('POST', '/auth/login', { email: 'client@siira.test', password: 'wrong' })).status, 401);
  });
  await step('client posts a job; talent cannot', async () => {
    const job = { title: 'Painter needed', description: 'Interior painting for a 3 bedroom house.', category: 'Trades & Repairs', type: 'Short-Term', province: 'Gauteng', city: 'Midrand', pay_min: 400, pay_max: 600, pay_unit: 'day' };
    assert.equal((await call('POST', '/jobs', job, talentTok)).status, 403);
    assert.equal((await call('POST', '/jobs', job)).status, 401);
    const r = await call('POST', '/jobs', job, clientTok);
    assert.equal(r.status, 201); jobId = r.body.data.id;
  });
  await step('talent applies once, saves, sees lists', async () => {
    assert.equal((await call('POST', `/jobs/${jobId}/apply`, { message: 'Available Monday' }, talentTok)).status, 201);
    assert.equal((await call('POST', `/jobs/${jobId}/apply`, {}, talentTok)).status, 409);
    assert.equal((await call('POST', `/jobs/${jobId}/save`, null, talentTok)).status, 204);
    assert.equal((await call('GET', '/me/saved', null, talentTok)).body.data.length, 1);
    assert.equal((await call('GET', '/me/applications', null, talentTok)).body.data.length, 1);
  });
  await step('only owner sees applicants and can close the job', async () => {
    assert.equal((await call('GET', `/jobs/${jobId}/applications`, null, talentTok)).status, 403);
    assert.equal((await call('GET', `/jobs/${jobId}/applications`, null, clientTok)).body.data.length, 1);
    assert.equal((await call('PATCH', `/jobs/${jobId}`, { status: 'closed' }, clientTok)).body.data.status, 'closed');
    assert.equal((await call('POST', `/jobs/${jobId}/apply`, {}, talentTok)).status, 404);
  });
  await step('profile update and hire request', async () => {
    const p = await call('PUT', '/me/profile', { headline: 'Painter', skills: ['Interior', 'Exterior'], hourly_rate: 180 }, talentTok);
    assert.equal(p.status, 200);
    const req = { from_name: 'Jo', from_email: 'jo@example.com', message: 'Need a quote for a rewire.' };
    assert.equal((await call('POST', '/talent/1/hire-request', req)).status, 404); // user 1 is the admin, not talent
    assert.equal((await call('POST', '/talent/3/hire-request', req)).status, 201);
  });
  await step('contract lifecycle: offer, escrow, deliver, release, review, payout', async () => {
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@siira.test', password: 'Siira#2026' })).body.token;
    const t2 = (await call('POST', '/auth/login', { email: 'talent1@siira.test', password: 'Siira#2026' })).body.token;
    const job = (await call('POST', '/jobs', { title: 'Rewire house', description: 'Full rewire of a small house.', category: 'Trades & Repairs', type: 'Freelance', province: 'Gauteng', city: 'Sandton', pay_min: 5000, pay_max: 9000, pay_unit: 'project' }, clientTok)).body.data;
    const o = await call('POST', '/contracts', { job_id: job.id, talent_id: 3, amount: 8000, description: 'Rewire, incl. DB board' }, clientTok);
    assert.equal(o.status, 201);
    const c = o.body.data;
    assert.equal(c.commission_cents, 80000); assert.equal(c.vat_cents, 12000); assert.equal(c.payout_cents, 708000);
    assert.equal((await call('POST', `/contracts/${c.id}/fund`, null, clientTok)).status, 409); // not accepted yet
    assert.equal((await call('POST', `/contracts/${c.id}/accept`, null, t2)).status, 200);
    assert.equal((await call('POST', `/contracts/${c.id}/fund`, null, clientTok)).body.mode, 'sandbox');
    assert.equal((await call('POST', `/contracts/${c.id}/fund/simulate`, null, clientTok)).status, 200);
    assert.equal((await call('POST', `/contracts/${c.id}/release`, null, clientTok)).status, 409); // not delivered
    assert.equal((await call('POST', `/contracts/${c.id}/deliver`, { note: 'Done, COC attached' }, t2)).status, 200);
    assert.equal((await call('POST', `/contracts/${c.id}/messages`, { body: 'Thanks!' }, clientTok)).status, 201);
    assert.equal((await call('GET', `/contracts/${c.id}`, null, talentTok)).status, 403); // outsider
    assert.equal((await call('POST', `/contracts/${c.id}/release`, null, clientTok)).status, 200);
    assert.equal((await call('POST', `/contracts/${c.id}/review`, { rating: 5, comment: 'Great' }, clientTok)).status, 201);
    assert.equal((await call('POST', `/contracts/${c.id}/payout`, { payout_ref: 'EFT-1' }, adminTok)).status, 404);
    assert.equal((await call('POST', `/admin/contracts/${c.id}/payout`, { payout_ref: 'EFT-1' }, clientTok)).status, 403);
    assert.equal((await call('POST', `/admin/contracts/${c.id}/payout`, { payout_ref: 'EFT-1' }, adminTok)).status, 200);
    const ov = (await call('GET', '/admin/overview', null, adminTok)).body;
    assert.equal(ov.gmv_cents, 800000); assert.equal(ov.revenue_cents, 80000); assert.equal(ov.vat_cents, 12000);
    const inv = await raw(`/contracts/${c.id}/invoice`, clientTok);
    assert.equal(inv.status, 200); assert.match(inv.text, /SIIRA-INV-0000/); assert.match(inv.text, /7[ \u00a0]080,00/);
    assert.equal((await raw(`/contracts/${c.id}/invoice`, talentTok)).status, 403);
    const csv = await raw('/admin/export/contracts.csv', adminTok);
    assert.match(csv.type, /csv/); assert.match(csv.text, /Commission excl VAT/); assert.equal((await raw('/admin/export/contracts.csv', clientTok)).status, 403);
    const me = (await call('GET', '/me/overview', null, t2)).body;
    assert.equal(me.earned_cents, 708000);
  });
  await step('disputes, verification, suspension and POPIA export/delete', async () => {
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@siira.test', password: 'Siira#2026' })).body.token;
    const t3 = (await call('POST', '/auth/login', { email: 'talent2@siira.test', password: 'Siira#2026' })).body.token;
    const job = (await call('POST', '/jobs', { title: 'Logo design', description: 'Logo and brand sheet.', category: 'Creative & Digital', type: 'Freelance', province: 'Western Cape', city: 'Cape Town', pay_min: 2000, pay_max: 4000, pay_unit: 'project' }, clientTok)).body.data;
    const cr = await call('POST', '/contracts', { job_id: job.id, talent_id: 4, amount: 3000, description: 'Logo and brand sheet' }, clientTok); const c = cr.body.data;
    await call('POST', `/contracts/${c.id}/accept`, null, t3);
    await call('POST', `/contracts/${c.id}/fund`, null, clientTok); await call('POST', `/contracts/${c.id}/fund/simulate`, null, clientTok);
    assert.equal((await call('POST', `/contracts/${c.id}/dispute`, { reason: 'Work was never delivered.' }, clientTok)).status, 200);
    assert.equal((await call('POST', `/admin/contracts/${c.id}/resolve`, { action: 'refund', note: 'No delivery' }, adminTok)).status, 200);
    assert.equal((await call('POST', `/admin/contracts/${c.id}/payout`, { payout_ref: 'REFUND-1' }, adminTok)).status, 200);
    assert.equal((await call('POST', '/me/verification', { id_type: 'SA ID', reference: '8001015009087' }, t3)).status, 201);
    const v = (await call('GET', '/admin/verifications', null, adminTok)).body.data;
    assert.equal(v[0].ref_last4, '9087');
    assert.equal((await call('POST', `/admin/verifications/${v[0].id}/decision`, { decision: 'approved' }, adminTok)).status, 200);
    assert.equal((await call('GET', '/talent/4')).body.data.verified, true);
    const ul = await call('GET', '/admin/users?q=Test%20Talent', null, adminTok); const u = ul.body.data[0];
    assert.equal((await call('PATCH', `/admin/users/${u.id}`, { status: 'suspended' }, adminTok)).status, 200);
    assert.equal((await call('GET', '/auth/me', null, talentTok)).status, 403); // suspended token stops working
    assert.equal((await call('GET', '/admin/overview', null, clientTok)).status, 403);
    assert.equal((await call('GET', '/me/export', null, clientTok)).body.account.email, 'client@siira.test');
    assert.equal((await call('POST', '/me/delete', { password: 'Siira#2026' }, t3)).status, 204);
    assert.equal((await call('POST', '/auth/login', { email: 'talent2@siira.test', password: 'Siira#2026' })).status, 401);
  });
  await step('password reset, contact inbox, config', async () => {
    assert.equal((await call('GET', '/config')).body.draft, true);
    assert.equal((await call('POST', '/auth/forgot', { email: 'nobody@siira.test' })).status, 200); // no enumeration
    await call('POST', '/auth/forgot', { email: 'talent6@siira.test' });
    const tok = outbox.filter(m => m.to === 'talent6@siira.test').pop().text.match(/reset=([a-f0-9]+)/)[1];
    assert.equal((await call('POST', '/auth/reset', { token: tok, password: 'weak' })).status, 400);
    assert.equal((await call('POST', '/auth/reset', { token: tok, password: 'NewPass2026x' })).status, 200);
    assert.equal((await call('POST', '/auth/reset', { token: tok, password: 'NewPass2026y' })).status, 400); // single use
    assert.equal((await call('POST', '/auth/login', { email: 'talent6@siira.test', password: 'NewPass2026x' })).status, 200);
    assert.equal((await call('POST', '/auth/login', { email: 'talent6@siira.test', password: 'Siira#2026' })).status, 401);
    assert.equal((await call('POST', '/contact', { name: 'Visitor', email: 'v@example.com', topic: 'Hiring', message: 'How do I hire a plumber?' })).status, 201);
    assert.equal((await call('POST', '/contact', { name: 'Bot', email: 'b@example.com', message: 'spam spam spam spam', website: 'http://x' })).status, 201); // honeypot: silently dropped
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@siira.test', password: 'Siira#2026' })).body.token;
    assert.equal((await call('GET', '/admin/inbox', null, adminTok)).body.data.length, 1);
  });
  await step('verification document upload, review and deletion', async () => {
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@siira.test', password: 'Siira#2026' })).body.token;
    const t = (await call('POST', '/auth/login', { email: 'talent3@siira.test', password: 'Siira#2026' })).body.token;
    const send = (blob, name) => { const fd = new FormData(); fd.append('id_type', 'SA ID'); fd.append('reference', '9001015009087'); fd.append('document', blob, name); return fetch(base + '/me/verification', { method: 'POST', headers: { authorization: 'Bearer ' + t }, body: fd }); };
    assert.equal((await send(new Blob(['not really a pdf'], { type: 'application/pdf' }), 'id.pdf')).status, 400); // fake PDF rejected
    assert.equal((await send(new Blob(['x'], { type: 'text/html' }), 'a.html')).status, 400);
    assert.equal((await send(new Blob(['%PDF-1.4 sample'], { type: 'application/pdf' }), 'id.pdf')).status, 201);
    const v = (await call('GET', '/admin/verifications', null, adminTok)).body.data.find(x => x.email === 'talent3@siira.test');
    const doc = await raw(`/admin/verifications/${v.id}/document`, adminTok);
    assert.equal(doc.status, 200); assert.match(doc.type, /pdf/);
    assert.equal((await raw(`/admin/verifications/${v.id}/document`, t)).status, 403);
    assert.equal((await call('POST', `/admin/verifications/${v.id}/decision`, { decision: 'approved' }, adminTok)).status, 200);
    assert.equal((await raw(`/admin/verifications/${v.id}/document`, adminTok)).status, 404); // file deleted after review
  });
  await step('unknown API route returns JSON 404', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
  });
  server.close();
  console.log('All smoke tests passed');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
