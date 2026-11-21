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
    assert.equal((await call('POST', '/auth/register', { name: 'No Consent', email: 'nc@talentbridge.test', password: 'Passw0rdOK', role: 'talent' })).status, 400); // POPIA consent required
    const r = await call('POST', '/auth/register', { name: 'Test Talent', email: 'new@talentbridge.test', password: 'Passw0rdOK', role: 'talent', province: 'Gauteng', accept_terms: true });
    assert.equal(r.status, 201); talentTok = r.body.token;
    assert.equal((await call('POST', '/jobs/1/apply', {}, talentTok)).status, 403); // email not verified yet
    const mail = outbox.filter(m => m.to === 'new@talentbridge.test').pop();
    const vt = mail.text.match(/token=([a-f0-9]+)/)[1];
    assert.equal((await fetch(base + '/auth/verify-email?token=' + vt, { redirect: 'manual' })).status, 302);
    assert.equal((await call('POST', '/auth/register', { name: 'Test Talent', email: 'NEW@talentbridge.test', password: 'Passw0rdOK', role: 'talent', accept_terms: true })).status, 409);
  });
  await step('login (good and bad)', async () => {
    const ok = await call('POST', '/auth/login', { email: 'client@talentbridge.test', password: 'TalentBridge#2026' });
    assert.equal(ok.status, 200); clientTok = ok.body.token;
    assert.equal((await call('POST', '/auth/login', { email: 'client@talentbridge.test', password: 'wrong' })).status, 401);
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
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@talentbridge.test', password: 'TalentBridge#2026' })).body.token;
    const t2 = (await call('POST', '/auth/login', { email: 'talent1@talentbridge.test', password: 'TalentBridge#2026' })).body.token;
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
    assert.equal(inv.status, 200); assert.match(inv.text, /TB-INV-0000/); assert.match(inv.text, /7[ \u00a0]080,00/);
    assert.equal((await raw(`/contracts/${c.id}/invoice`, talentTok)).status, 403);
    const csv = await raw('/admin/export/contracts.csv', adminTok);
    assert.match(csv.type, /csv/); assert.match(csv.text, /Commission excl VAT/); assert.equal((await raw('/admin/export/contracts.csv', clientTok)).status, 403);
    const me = (await call('GET', '/me/overview', null, t2)).body;
    assert.equal(me.earned_cents, 708000);
  });
  await step('disputes, verification, suspension and POPIA export/delete', async () => {
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@talentbridge.test', password: 'TalentBridge#2026' })).body.token;
    const t3 = (await call('POST', '/auth/login', { email: 'talent2@talentbridge.test', password: 'TalentBridge#2026' })).body.token;
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
    assert.equal((await call('GET', '/me/export', null, clientTok)).body.account.email, 'client@talentbridge.test');
    assert.equal((await call('POST', '/me/delete', { password: 'TalentBridge#2026' }, t3)).status, 204);
    assert.equal((await call('POST', '/auth/login', { email: 'talent2@talentbridge.test', password: 'TalentBridge#2026' })).status, 401);
  });
  await step('password reset, contact inbox, config', async () => {
    assert.equal((await call('GET', '/config')).body.draft, true);
    assert.equal((await call('POST', '/auth/forgot', { email: 'nobody@talentbridge.test' })).status, 200); // no enumeration
    await call('POST', '/auth/forgot', { email: 'talent6@talentbridge.test' });
    const tok = outbox.filter(m => m.to === 'talent6@talentbridge.test').pop().text.match(/reset=([a-f0-9]+)/)[1];
    assert.equal((await call('POST', '/auth/reset', { token: tok, password: 'weak' })).status, 400);
    assert.equal((await call('POST', '/auth/reset', { token: tok, password: 'NewPass2026x' })).status, 200);
    assert.equal((await call('POST', '/auth/reset', { token: tok, password: 'NewPass2026y' })).status, 400); // single use
    assert.equal((await call('POST', '/auth/login', { email: 'talent6@talentbridge.test', password: 'NewPass2026x' })).status, 200);
    assert.equal((await call('POST', '/auth/login', { email: 'talent6@talentbridge.test', password: 'TalentBridge#2026' })).status, 401);
    assert.equal((await call('POST', '/contact', { name: 'Visitor', email: 'v@example.com', topic: 'Hiring', message: 'How do I hire a plumber?' })).status, 201);
    assert.equal((await call('POST', '/contact', { name: 'Bot', email: 'b@example.com', message: 'spam spam spam spam', website: 'http://x' })).status, 201); // honeypot: silently dropped
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@talentbridge.test', password: 'TalentBridge#2026' })).body.token;
    assert.equal((await call('GET', '/admin/inbox', null, adminTok)).body.data.length, 1);
  });
  await step('verification document upload, review and deletion', async () => {
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@talentbridge.test', password: 'TalentBridge#2026' })).body.token;
    const t = (await call('POST', '/auth/login', { email: 'talent3@talentbridge.test', password: 'TalentBridge#2026' })).body.token;
    const send = (blob, name) => { const fd = new FormData(); fd.append('id_type', 'SA ID'); fd.append('reference', '9001015009087'); fd.append('document', blob, name); return fetch(base + '/me/verification', { method: 'POST', headers: { authorization: 'Bearer ' + t }, body: fd }); };
    assert.equal((await send(new Blob(['not really a pdf'], { type: 'application/pdf' }), 'id.pdf')).status, 400); // fake PDF rejected
    assert.equal((await send(new Blob(['x'], { type: 'text/html' }), 'a.html')).status, 400);
    assert.equal((await send(new Blob(['%PDF-1.4 sample'], { type: 'application/pdf' }), 'id.pdf')).status, 201);
    const v = (await call('GET', '/admin/verifications', null, adminTok)).body.data.find(x => x.email === 'talent3@talentbridge.test');
    const doc = await raw(`/admin/verifications/${v.id}/document`, adminTok);
    assert.equal(doc.status, 200); assert.match(doc.type, /pdf/);
    assert.equal((await raw(`/admin/verifications/${v.id}/document`, t)).status, 403);
    assert.equal((await call('POST', `/admin/verifications/${v.id}/decision`, { decision: 'approved' }, adminTok)).status, 200);
    assert.equal((await raw(`/admin/verifications/${v.id}/document`, adminTok)).status, 404); // file deleted after review
  });
  await step('bids: place, edit, see sorted list, shortlist, chat, award with milestones', async () => {
    const pw = 'TalentBridge#2026';
    const cl = (await call('POST', '/auth/login', { email: 'client@talentbridge.test', password: pw })).body.token;
    const t4 = (await call('POST', '/auth/login', { email: 'talent4@talentbridge.test', password: pw })).body.token;
    const t5 = (await call('POST', '/auth/login', { email: 'talent5@talentbridge.test', password: pw })).body.token;
    const t4id = (await call('GET', '/auth/me', null, t4)).body.user.id;
    const job = (await call('POST', '/jobs', { title: 'React website developer', description: 'Build a React booking website with payments.', category: 'Creative & Digital', type: 'Freelance', province: 'Gauteng', city: 'Pretoria', pay_min: 5000, pay_max: 12000, pay_unit: 'project' }, cl)).body.data;
    // talent5 is a "Web Developer" with React skills: gets a matching-job alert
    assert.ok((await call('GET', '/me/notifications', null, t5)).body.data.some(n => n.type === 'job_match' && n.link === `#job/${job.id}`));
    // live stream for the client
    const ctrl = new AbortController(), events = [];
    const sr = await fetch(base + '/me/stream', { headers: { authorization: 'Bearer ' + cl }, signal: ctrl.signal });
    assert.equal(sr.status, 200);
    (async () => { const rd = sr.body.getReader(), dec = new TextDecoder(); try { for (;;) { const { value, done } = await rd.read(); if (done) break; events.push(dec.decode(value)); } } catch {} })();
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await call('POST', `/jobs/${job.id}/apply`, { bid_amount: 9000, delivery_days: 14, message: 'I build React sites with Paystack.' }, t4)).status, 201);
    assert.equal((await call('POST', `/jobs/${job.id}/apply`, { bid_amount: 7000, delivery_days: 21, message: 'Fast and affordable.' }, t5)).status, 201);
    assert.equal((await call('PUT', `/jobs/${job.id}/apply`, { bid_amount: 8500, delivery_days: 10, message: 'Updated proposal.' }, t4)).status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(events.join('').includes('event: notification') && events.join('').includes('bid'), 'bid pushed live');
    const bids = (await call('GET', `/jobs/${job.id}/applications?sort=price`, null, cl)).body.data;
    assert.equal(bids.length, 2); assert.equal(bids[0].bid_amount, 7000); assert.equal(bids[1].bid_amount, 8500);
    const t4bid = bids.find(b => b.talent_id === t4id);
    assert.equal((await call('PATCH', `/jobs/${job.id}/applications/${t4bid.id}`, { status: 'shortlisted' }, cl)).status, 200);
    assert.equal((await call('GET', `/jobs/${job.id}`, null, t4)).body.data.my_bid.bid_amount, 8500);
    assert.equal((await call('GET', `/jobs/${job.id}`)).body.data.bids, 2);
    // chat from the bid
    const conv = (await call('POST', `/jobs/${job.id}/applications/${t4bid.id}/chat`, { body: 'Can you start Monday?' }, cl)).body.data.conversation_id;
    assert.equal((await call('GET', '/me/counts', null, t4)).body.inbox, 1);
    const inbox = (await call('GET', '/inbox', null, t4)).body.data;
    assert.equal(inbox[0].id, conv); assert.equal(inbox[0].unread, 1); assert.equal(inbox[0].job_title, 'React website developer');
    assert.equal((await call('POST', `/inbox/${conv}/messages`, { body: 'Yes, Monday works.' }, t4)).status, 201);
    assert.equal((await call('POST', `/inbox/${conv}/read`, {}, t4)).body.counts.inbox, 0);
    assert.equal((await call('GET', `/inbox/${conv}`, null, t5)).status, 403); // not a party
    // award the bid with two milestones
    const offer = await call('POST', '/contracts', { application_id: t4bid.id, description: 'React booking site', milestones: [{ title: 'Design', amount: 3000 }, { title: 'Build and launch', amount: 5500 }] }, cl);
    assert.equal(offer.status, 201); assert.equal(offer.body.data.amount_cents, 850000);
    const cid = offer.body.data.id;
    assert.equal((await call('POST', '/contracts', { application_id: t4bid.id, description: 'Duplicate offer' }, cl)).status, 409);
    const tFeed = (await call('GET', '/me/feed', null, t4)).body;
    assert.ok(tFeed.todo.some(t => t.kind === 'offer' && t.link === `#contracts/${cid}`));
    assert.ok(tFeed.activity.some(a => a.type === 'offer' && a.actor_name === 'Demo Client'));
    assert.equal((await call('POST', `/contracts/${cid}/accept`, {}, t4)).status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(events.join('').includes('accepted your offer'), 'offer accepted pushed live to client');
    const cFeed = (await call('GET', '/me/feed', null, cl)).body;
    assert.ok(cFeed.todo.some(t => t.kind === 'fund')); assert.ok(cFeed.recent_bids.length >= 2);
    // timeline lines are in the inbox thread
    const thread = (await call('GET', `/inbox/${conv}`, null, cl)).body.data;
    assert.ok(thread.messages.some(m => m.kind === 'event' && m.body.startsWith('Offer accepted')));
    assert.ok(thread.contracts.some(c => c.id === cid));
    await call('POST', `/contracts/${cid}/fund`, {}, cl); await call('POST', `/contracts/${cid}/fund/simulate`, {}, cl);
    const ms = (await call('GET', `/contracts/${cid}`, null, t4)).body.milestones;
    assert.equal(ms.length, 2);
    assert.equal((await call('POST', `/contracts/${cid}/milestones/${ms[0].id}/approve`, {}, cl)).status, 409); // not submitted yet
    assert.equal((await call('POST', `/contracts/${cid}/milestones/${ms[0].id}/submit`, {}, t4)).status, 200);
    assert.equal((await call('POST', `/contracts/${cid}/milestones/${ms[0].id}/approve`, {}, cl)).body.data[0].status, 'approved');
    ctrl.abort();
  });
  await step('inbox: direct message, attachments, withdraw bid, profile portfolio, meta', async () => {
    const pw = 'TalentBridge#2026';
    const cl = (await call('POST', '/auth/login', { email: 'client@talentbridge.test', password: pw })).body.token;
    const t1 = (await call('POST', '/auth/login', { email: 'talent1@talentbridge.test', password: pw })).body.token;
    const t1id = (await call('GET', '/auth/me', null, t1)).body.user.id;
    const cid = (await call('GET', '/auth/me', null, cl)).body.user.id;
    const t3 = (await call('POST', '/auth/login', { email: 'talent3@talentbridge.test', password: pw })).body.token;
    assert.equal((await call('POST', '/inbox', { user_id: cid }, t3)).status, 403); // talent cannot cold-message a client
    const c = (await call('POST', `/talent/${t1id}/message`, { body: 'Hi Thando, are you free next week?' }, cl)).body.data.conversation_id;
    const fd = new FormData();
    fd.append('body', 'Here is the floor plan');
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'plan.pdf');
    const up = await fetch(`${base}/inbox/${c}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + cl }, body: fd });
    assert.equal(up.status, 201);
    const mid = (await up.json()).data.id;
    const file = await raw(`/inbox/${c}/files/${mid}`, t1);
    assert.equal(file.status, 200); assert.ok(file.text.startsWith('%PDF'));
    const bad = new FormData(); bad.append('file', new Blob(['not a png'], { type: 'image/png' }), 'x.png');
    assert.equal((await fetch(`${base}/inbox/${c}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + cl }, body: bad })).status, 400);
    assert.equal((await call('POST', `/inbox/${c}/messages`, { body: 'Yes I am.' }, t1)).status, 201);
    assert.equal((await call('POST', '/inbox', { user_id: cid, body: 'Following up' }, t1)).status, 201); // existing thread: allowed now
    // withdraw a bid
    const job = (await call('GET', '/jobs?q=Delivery', null)).body.data[0];
    assert.equal((await call('POST', `/jobs/${job.id}/apply`, { bid_amount: 400, delivery_days: 1 }, t1)).status, 201);
    assert.equal((await call('DELETE', `/jobs/${job.id}/apply`, null, t1)).status, 204);
    assert.equal((await call('PUT', '/me/profile', { languages: 'English, isiZulu', portfolio: [{ title: 'Solar install', url: 'https://example.com/solar', description: '5 kW home system' }] }, t1)).status, 200);
    const prof = (await call('GET', `/talent/${t1id}`)).body.data;
    assert.equal(prof.portfolio[0].title, 'Solar install'); assert.ok(Array.isArray(prof.reviews)); assert.equal(prof.reviews.length, 1);
    const meta = (await call('GET', '/meta')).body;
    assert.equal(meta.brand.name, 'TalentBridge'); assert.equal(meta.categories.length, 6); assert.ok(meta.categories[0].open_jobs >= 0);
    assert.ok('jobs_completed' in (await call('GET', '/stats')).body);
  });
  await step('unknown API route returns JSON 404', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
  });
  server.close();
  console.log('All smoke tests passed');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
