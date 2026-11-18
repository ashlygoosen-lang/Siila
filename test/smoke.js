process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
const assert = require('node:assert/strict');
const app = require('../src/server');

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
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
    const r = await call('POST', '/auth/register', { name: 'Test Talent', email: 'new@siira.test', password: 'Passw0rdOK', role: 'talent', province: 'Gauteng' });
    assert.equal(r.status, 201); talentTok = r.body.token;
    assert.equal((await call('POST', '/auth/register', { name: 'Test Talent', email: 'NEW@siira.test', password: 'Passw0rdOK', role: 'talent' })).status, 409);
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
    assert.equal((await call('POST', '/talent/1/hire-request', req)).status, 404); // user 1 is the client, not talent
    assert.equal((await call('POST', '/talent/2/hire-request', req)).status, 201);
  });
  await step('unknown API route returns JSON 404', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
  });
  server.close();
  console.log('All smoke tests passed');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
