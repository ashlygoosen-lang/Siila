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
  const raw0 = async (url, token) => { const r = await fetch(base + url, { headers: { authorization: 'Bearer ' + token } }); return { status: r.status }; };
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
    assert.equal(meta.brand.name, 'TalentBridge'); assert.equal(meta.categories.length, 18); assert.ok(meta.categories[0].open_jobs >= 0);
    assert.ok('jobs_completed' in (await call('GET', '/stats')).body);
    assert.equal((await call('GET', '/provinces')).body.data.length, 9);
    const rv = (await call('GET', '/reviews')).body.data;
    assert.ok(Array.isArray(rv)); rv.forEach(r => { assert.ok(r.rating >= 4); assert.ok(!r.client_name.includes('Client') || r.client_name.endsWith('.')); });
  });
  await step('identity verification (KYC): validation, gates, encryption, review, fraud checks', async () => {
    const K = require('../src/kyc');
    const fs = require('fs'), path = require('path');
    // Build valid SA ID numbers (Luhn check digit)
    const saId = (first12) => { for (let c = 0; c < 10; c++) { const id = first12 + c; if (K.parseSaId(id).ok) return id; } };
    const id1 = saId('900101500908'), id2 = saId('850615012308');
    assert.equal(K.parseSaId(id1).dob, '1990-01-01');
    assert.equal(K.parseSaId('9001015009081').ok, K.parseSaId('9001015009081').ok && id1 === '9001015009081');
    assert.equal(K.parseSaId('123').ok, false);
    assert.equal(K.parseSaId(id1.slice(0, 12) + ((Number(id1[12]) + 1) % 10)).ok, false); // wrong check digit
    const pw = 'TalentBridge#2026';
    const adminTok = (await call('POST', '/auth/login', { email: 'admin@talentbridge.test', password: pw })).body.token;
    const reg = async (email, role) => {
      const r = await call('POST', '/auth/register', { name: 'Kyc ' + role, email, password: 'Passw0rdOK', role, accept_terms: true, province: 'Gauteng' });
      const vt = outbox.filter(m => m.to === email).pop().text.match(/token=([a-f0-9]+)/)[1];
      await fetch(base + '/auth/verify-email?token=' + vt, { redirect: 'manual' });
      return { tok: r.body.token, id: r.body.user.id };
    };
    const cl = await reg('kyc-client@talentbridge.test', 'client');
    const job = (await call('POST', '/jobs', { title: 'Paint my lounge', description: 'Two coats on four walls, paint supplied.', category: 'Construction', type: 'Short-Term', province: 'Gauteng', city: 'Midrand', pay_min: 1500, pay_max: 3000, pay_unit: 'project' }, cl.tok)).body.data;
    const t2 = (await call('POST', '/auth/login', { email: 'talent5@talentbridge.test', password: pw })).body.token;
    const t2id = (await call('GET', '/auth/me', null, t2)).body.user.id;
    // Unverified client is blocked from offers
    const blocked = await call('POST', '/contracts', { job_id: job.id, talent_id: t2id, amount: 2000, description: 'Paint lounge' }, cl.tok);
    assert.equal(blocked.status, 403); assert.ok(blocked.body.error.includes('Verify your identity'));
    // Details: validation
    const details = { account_type: 'individual', legal_name: 'Kyc Client Person', id_type: 'sa_id', id_number: id1, nationality: 'South African', phone: '082 555 1234', address_line: '12 Main Road', suburb: 'Halfway House', city: 'Midrand', province: 'Gauteng', postal_code: '1685', is_pep: false, consent: true };
    assert.equal((await call('PUT', '/kyc/details', { ...details, id_number: '9001015009080' }, cl.tok)).status, 400); // bad checksum
    assert.equal((await call('PUT', '/kyc/details', { ...details, dob: '1991-01-01' }, cl.tok)).status, 400); // DOB mismatch
    const d1 = await call('PUT', '/kyc/details', details, cl.tok);
    assert.equal(d1.status, 200); assert.equal(d1.body.data.details.dob, '1990-01-01'); assert.ok(d1.body.data.details.id_number_masked.endsWith(id1.slice(-4)));
    // Stored encrypted, not in clear
    const row = require('../src/db').prepare('SELECT * FROM kyc_profiles WHERE user_id = ?').get(cl.id);
    assert.ok(!row.id_number_enc.includes(id1) && row.id_number_enc.length > 20);
    // Documents
    const jpeg = (n = 1) => Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(12000, n)]);
    const up = async (tok, kind, buf, type = 'image/jpeg', extra = {}) => {
      const fd = new FormData(); fd.append('kind', kind); for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      fd.append('file', new Blob([buf], { type }), kind + (type === 'application/pdf' ? '.pdf' : '.jpg'));
      const r = await fetch(base + '/kyc/documents', { method: 'POST', headers: { authorization: 'Bearer ' + tok }, body: fd });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await up(cl.tok, 'selfie', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(12000)]), 'application/pdf')).status, 400); // selfie must be photo
    assert.equal((await up(cl.tok, 'id_front', Buffer.alloc(12000, 7), 'image/jpeg')).status, 400); // fake jpeg
    assert.equal((await call('POST', '/kyc/submit', {}, cl.tok)).status, 400); // incomplete
    for (const [k, n] of [['id_front', 1], ['proof_of_address', 2], ['selfie', 3]]) assert.equal((await up(cl.tok, k, jpeg(n))).status, 201);
    const files = require('../src/db').prepare('SELECT file_path FROM kyc_documents WHERE user_id = ?').all(cl.id);
    const raw = fs.readFileSync(path.join(require('../src/routes/kyc').KYC_DIR, files[0].file_path));
    assert.notEqual(raw.subarray(0, 3).toString('hex'), 'ffd8ff'); // encrypted on disk
    const sub = await call('POST', '/kyc/submit', {}, cl.tok);
    assert.equal(sub.status, 200); assert.equal(sub.body.data.status, 'pending');
    assert.equal((await up(cl.tok, 'selfie', jpeg(9))).status, 409); // locked while under review
    assert.ok((await call('GET', '/me/notifications', null, adminTok)).body.data.some(n => n.type === 'kyc' && n.link === '#admin/kyc/' + cl.id));
    // Admin review
    const queue = (await call('GET', '/admin/kyc?status=pending', null, adminTok)).body.data;
    assert.ok(queue.some(q => q.id === cl.id));
    const det = (await call('GET', '/admin/kyc/' + cl.id, null, adminTok)).body.data;
    assert.equal(det.details.id_number, id1); assert.equal(det.details.sa_id_check.ok, true); assert.equal(det.details.age >= 18, true);
    const docFile = await raw0(`/admin/kyc/documents/${det.docs[0].id}/file`, adminTok);
    assert.equal(docFile.status, 200);
    assert.equal((await call('POST', `/admin/kyc/${cl.id}/decision`, { decision: 'approved' }, adminTok)).status, 409); // docs not approved yet
    for (const d of det.docs) assert.equal((await call('POST', `/admin/kyc/documents/${d.id}/decision`, { decision: 'approved' }, adminTok)).status, 200);
    assert.equal((await call('POST', `/admin/kyc/${cl.id}/decision`, { decision: 'approved' }, adminTok)).status, 200);
    assert.equal((await call('GET', '/auth/me', null, cl.tok)).body.user.kyc_status, 'approved');
    assert.equal((await call('POST', '/contracts', { job_id: job.id, talent_id: t2id, amount: 2000, description: 'Paint lounge' }, cl.tok)).status, 201); // now allowed
    assert.ok((await call('GET', '/admin/audit', null, adminTok)).body.data.some(a => a.action === 'kyc.document_viewed'));
    // Duplicate identity: second account with the same ID number is flagged and cannot be approved
    const dup = await reg('kyc-dup@talentbridge.test', 'client');
    assert.equal((await call('PUT', '/kyc/details', { ...details, legal_name: 'Someone Else' }, dup.tok)).status, 200);
    for (const [k, n] of [['id_front', 1], ['proof_of_address', 5], ['selfie', 6]]) await up(dup.tok, k, jpeg(n)); // id_front is the same file
    await call('POST', '/kyc/submit', {}, dup.tok);
    const flags = (await call('GET', '/admin/kyc/' + dup.id, null, adminTok)).body.data.flags;
    assert.ok(flags.some(f => f.kind === 'duplicate_id' && f.severity === 'high'));
    assert.ok(flags.some(f => f.kind === 'duplicate_document'));
    for (const d of (await call('GET', '/admin/kyc/' + dup.id, null, adminTok)).body.data.docs) await call('POST', `/admin/kyc/documents/${d.id}/decision`, { decision: 'approved' }, adminTok);
    const blockedApprove = await call('POST', `/admin/kyc/${dup.id}/decision`, { decision: 'approved' }, adminTok);
    assert.equal(blockedApprove.status, 409); assert.ok(blockedApprove.body.error.includes('duplicate_id'));
    assert.equal((await call('POST', `/admin/kyc/${dup.id}/decision`, { decision: 'rejected', note: 'Identity already used by another account' }, adminTok)).status, 200);
    // Professional: CV, qualification confirmed with institution, bank details
    const pro = await reg('kyc-pro@talentbridge.test', 'talent');
    await call('PUT', '/kyc/details', { ...details, legal_name: 'Kyc Pro Person', id_number: id2 }, pro.tok);
    for (const [k, n] of [['id_front', 11], ['proof_of_address', 12], ['selfie', 13]]) await up(pro.tok, k, jpeg(n));
    let st = (await call('GET', '/kyc', null, pro.tok)).body.data;
    assert.ok(st.requirements.some(r => r.key === 'cv' && !r.done) && st.requirements.some(r => r.key === 'qualifications'));
    assert.equal((await up(pro.tok, 'cv', jpeg(14))).status, 400); // CV must be PDF/Word
    assert.equal((await up(pro.tok, 'cv', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(3000)]), 'application/pdf')).status, 201);
    assert.equal((await call('POST', '/kyc/qualifications', { institution: 'Tshwane University of Technology', qualification: 'National Diploma: Electrical Engineering', year: 2015, student_number: '212345678' }, pro.tok)).status, 400); // consent
    const q = (await call('POST', '/kyc/qualifications', { institution: 'Tshwane University of Technology', qualification: 'National Diploma: Electrical Engineering', year: 2015, student_number: '212345678', consent_to_contact: true }, pro.tok)).body.data;
    assert.equal((await up(pro.tok, 'qualification', jpeg(15), 'image/jpeg', { qualification_id: String(q.id) })).status, 201);
    assert.equal((await call('PUT', '/kyc/bank', { holder: 'Mr Someone Different', bank: 'FNB', account_number: '62123456789', branch_code: '250655', account_type: 'cheque' }, pro.tok)).status, 200);
    assert.equal((await call('POST', '/kyc/submit', {}, pro.tok)).status, 200);
    const pdet = (await call('GET', '/admin/kyc/' + pro.id, null, adminTok)).body.data;
    assert.equal(pdet.bank.account_number, '62123456789'); assert.equal(pdet.bank.holder_matches, false);
    assert.ok(pdet.flags.some(f => f.kind === 'bank_name_mismatch'));
    assert.equal((await call('POST', `/admin/qualifications/${q.id}/verify`, { outcome: 'verified', method: 'institution_email', contact: 'records@tut.ac.za' }, adminTok)).status, 400); // reference required
    assert.equal((await call('POST', `/admin/qualifications/${q.id}/verify`, { outcome: 'verified', method: 'institution_email', contact: 'records@tut.ac.za', reference: 'TUT confirmation email 21 Nov 2026' }, adminTok)).status, 200);
    for (const d of pdet.docs) await call('POST', `/admin/kyc/documents/${d.id}/decision`, { decision: 'approved' }, adminTok);
    assert.equal((await call('POST', `/admin/kyc/${pro.id}/decision`, { decision: 'approved' }, adminTok)).status, 200); // medium flag doesn't block
    const pub = (await call('GET', '/talent/' + pro.id)).body.data;
    assert.equal(pub.verified, true); assert.equal(pub.checks.identity, true); assert.equal(pub.checks.address, true);
    assert.ok(pub.qualifications.some(x => x.verified && x.institution.includes('Tshwane')));
    // CV access only with a relationship
    assert.equal((await raw0(`/talent/${pro.id}/cv`, cl.tok)).status, 403);
    // Bank change after approval: member is warned and a flag is raised
    await call('PUT', '/kyc/bank', { holder: 'Kyc Pro Person', bank: 'Capitec', account_number: '1234567890', branch_code: '470010', account_type: 'savings' }, pro.tok);
    assert.ok((await call('GET', '/me/notifications', null, pro.tok)).body.data.some(n => n.type === 'security'));
    assert.ok((await call('GET', '/admin/risk-flags', null, adminTok)).body.data.some(f => f.kind === 'bank_changed' && f.user_id === pro.id));
    assert.ok(K.payoutBlockers({ id: 0, client_id: cl.id, talent_id: pro.id, aml_hold: 0 }).some(b => b.includes('72 hours')));
    // Clear a flag
    const fl = (await call('GET', '/admin/risk-flags', null, adminTok)).body.data.find(f => f.kind === 'bank_name_mismatch' && f.user_id === pro.id);
    assert.equal((await call('POST', `/admin/risk-flags/${fl.id}/resolve`, { outcome: 'cleared', note: 'Holder name updated to match ID' }, adminTok)).status, 200);
    // Brute-force lockout after 5 wrong passwords
    for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { email: 'kyc-dup@talentbridge.test', password: 'wrong' + i });
    assert.equal((await call('POST', '/auth/login', { email: 'kyc-dup@talentbridge.test', password: 'Passw0rdOK' })).status, 429);
  });
  await step('skills catalogue and international sponsorship after the local search period', async () => {
    const dbx = require('../src/db');
    const sk = (await call('GET', '/skills')).body.data;
    assert.equal(sk.critical.length, 142); assert.ok(sk.critical.some(c => c.ofo === '2021-251201' && c.name === 'Software Developer' && c.nqf === 7));
    assert.ok(Object.keys(sk.general).length >= 18);
    assert.ok((await call('GET', '/skills?q=plumb')).body.data.some(x => x.name === 'Plumber'));
    const pw = 'TalentBridge#2026';
    const admin = (await call('POST', '/auth/login', { email: 'admin@talentbridge.test', password: pw })).body.token;
    const client = (await call('POST', '/auth/login', { email: 'client@talentbridge.test', password: pw })).body.token;
    const r = await call('POST', '/auth/register', { name: 'Amara Okafor', email: 'amara@talentbridge.test', password: 'Passw0rdOK', role: 'talent', accept_terms: true, province: 'Gauteng' });
    const vt = outbox.filter(m => m.to === 'amara@talentbridge.test').pop().text.match(/token=([a-f0-9]+)/)[1];
    await fetch(base + '/auth/verify-email?token=' + vt, { redirect: 'manual' });
    const ft = r.body.token, fid = r.body.user.id;
    assert.equal((await call('PUT', '/me/profile', { residency: 'foreign', work_rights: 'needs_sponsorship', country: 'Nigeria', nationality: 'Nigerian', relocate: true, occupation_ofo: '2021-251201', experience_years: 8, saqa_status: 'applied' }, ft)).status, 200);
    const job = (await call('POST', '/jobs', { title: 'Senior software developer (permanent)', description: 'Build and maintain our logistics platform in Node and React.', category: 'IT & Software', type: 'Full-Time', province: 'Gauteng', city: 'Sandton', pay_min: 60000, pay_max: 80000, pay_unit: 'month', contract_term: 'permanent', occupation_ofo: '2021-251201' }, client)).body.data;
    assert.equal(job.critical_skill, true); assert.equal(job.long_term, true); assert.equal(job.open_to_international, false);
    const short = (await call('POST', '/jobs', { title: 'Fix a leaking geyser', description: 'Geyser is leaking from the valve, needs replacing.', category: 'Trades & Repairs', type: 'Short-Term', province: 'Gauteng', city: 'Sandton', pay_min: 800, pay_max: 1500, pay_unit: 'project' }, client)).body.data;
    const remote = (await call('POST', '/jobs', { title: 'Design a logo for a bakery', description: 'Logo and colours for a small bakery brand, delivered as files.', category: 'Creative & Digital', type: 'Freelance', province: 'Gauteng', city: 'Sandton', pay_min: 1500, pay_max: 3000, pay_unit: 'project', remote: true }, client)).body.data;
    // Foreign professional without work rights: sees remote jobs only, can't bid on local jobs
    const seen = (await call('GET', '/jobs?limit=50', null, ft)).body.data.map(j => j.id);
    assert.ok(!seen.includes(job.id) && !seen.includes(short.id) && seen.includes(remote.id));
    assert.equal((await call('POST', `/jobs/${job.id}/apply`, { message: 'Interested' }, ft)).status, 403);
    assert.equal((await call('POST', `/jobs/${remote.id}/apply`, { message: 'I can do this remotely', bid_amount: 2000, delivery_days: 5 }, ft)).status, 201);
    // Client can't open the job to foreign nationals before the local search period ends
    const body = { local_applicants: 14, local_reason: 'We interviewed 6 local applicants; none had production experience with high-volume logistics systems.', salary_annual: 900000, confirm: true };
    const early = await call('POST', `/jobs/${job.id}/international`, body, client);
    assert.equal(early.status, 409); assert.ok(early.body.error.includes('90 days'));
    assert.equal((await call('POST', `/jobs/${short.id}/international`, body, client)).status, 409);
    dbx.prepare("UPDATE jobs SET created_at = datetime('now','-91 days') WHERE id IN (?,?)").run(job.id, short.id);
    const det = (await call('GET', '/jobs/' + job.id, null, client)).body.data.international;
    assert.equal(det.eligible, true); assert.equal(det.route, 'critical_skills');
    assert.equal((await call('POST', `/jobs/${job.id}/international`, { ...body, local_reason: 'None fit' }, client)).status, 400);
    assert.ok((await call('POST', `/jobs/${short.id}/international`, body, client)).body.error.includes('Full-time'));
    const reqd = await call('POST', `/jobs/${job.id}/international`, body, client);
    assert.equal(reqd.status, 200);
    assert.equal((await call('POST', `/jobs/${job.id}/apply`, { message: 'Interested' }, ft)).status, 403); // still waiting for review
    const intl = (await call('GET', '/admin/international', null, admin)).body.data;
    assert.ok(intl.jobs.some(j => j.id === job.id && j.intl_status === 'requested' && j.route_label === 'Critical Skills Work Visa'));
    assert.equal((await call('POST', `/admin/international/jobs/${job.id}/decision`, { decision: 'approved' }, admin)).status, 200);
    assert.ok((await call('GET', '/me/notifications', null, ft)).body.data.some(n => n.text.includes('visa sponsorship')));
    assert.ok((await call('GET', '/jobs?international=true', null, ft)).body.data.some(j => j.id === job.id && j.open_to_international));
    assert.equal((await call('POST', `/jobs/${job.id}/apply`, { message: 'I have 8 years of Node and React experience and can relocate.' }, ft)).status, 201);
    const app = (await call('GET', `/jobs/${job.id}/applications`, null, client)).body.data.find(a => a.user_id === fid || a.name === 'Amara Okafor');
    const offer = { application_id: app.id, salary_annual: 900000, start_date: '2027-03-01', terms: 'Permanent, 40 hours a week, medical aid and relocation allowance.', confirm: true };
    assert.equal((await call('POST', '/sponsorships', offer, client)).status, 409); // professional not verified yet
    dbx.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").run(fid);
    const sp = await call('POST', '/sponsorships', offer, client);
    assert.equal(sp.status, 201); assert.equal(sp.body.data.route, 'critical_skills'); assert.ok(sp.body.data.checklist.length > 5);
    assert.equal((await call('POST', '/sponsorships', offer, client)).status, 409); // no duplicate offer
    assert.equal((await call('POST', `/admin/sponsorships/${sp.body.data.id}/status`, { status: 'documents' }, admin)).status, 409); // not accepted yet
    assert.equal((await call('POST', `/sponsorships/${sp.body.data.id}/respond`, { accept: true }, ft)).status, 200);
    assert.equal((await call('GET', '/jobs/' + job.id)).body.data.status, 'closed');
    assert.equal((await call('POST', `/admin/sponsorships/${sp.body.data.id}/status`, { status: 'submitted' }, admin)).status, 400); // reference needed
    assert.equal((await call('POST', `/admin/sponsorships/${sp.body.data.id}/status`, { status: 'submitted', reference: 'VFS-PTA-123456' }, admin)).status, 200);
    const fin = (await call('POST', `/admin/sponsorships/${sp.body.data.id}/status`, { status: 'approved', note: 'Visa issued for 5 years' }, admin)).body.data;
    assert.equal(fin.status, 'approved'); assert.equal(fin.events.length, 4);
    assert.ok((await call('GET', '/sponsorships', null, ft)).body.data.some(x => x.id === fin.id && x.status_label === 'Visa approved'));
    assert.equal((await call('GET', `/sponsorships/${fin.id}`, null, (await call('POST', '/auth/login', { email: 'talent1@talentbridge.test', password: pw })).body.token)).status, 403);
    const pub = (await call('GET', '/talent/' + fid)).body.data;
    assert.equal(pub.international, true); assert.equal(pub.occupation, 'Software Developer'); assert.equal(pub.country, 'Nigeria');
  });
  await step('PayFast: signed checkout, verified ITN funds escrow, forged or wrong-amount ITNs are ignored', async () => {
    const PF = require('../src/payfast');
    // PHP urlencode compatibility
    assert.equal(PF.enc('Test item & more'), 'Test+item+%26+more'); assert.equal(PF.enc("a~b!c'(d)*"), 'a%7Eb%21c%27%28d%29%2A');
    // signature matches the reference algorithm (fields in order, trimmed, empty skipped, passphrase last)
    const f = { merchant_id: '10000100', merchant_key: '46f0cd694581a', amount: '100.00', item_name: ' Test product ', name_last: '' };
    assert.equal(PF.checkoutSignature(f, 'jt7NOE43FZPn'), PF.md5('merchant_id=10000100&merchant_key=46f0cd694581a&amount=100.00&item_name=Test+product&passphrase=jt7NOE43FZPn'));
    process.env.PAYMENTS_MODE = 'payfast'; process.env.PAYFAST_SKIP_IP_CHECK = 'true'; process.env.PAYFAST_SKIP_VALIDATE = 'true';
    try {
      const pw = 'TalentBridge#2026';
      const cl = (await call('POST', '/auth/login', { email: 'client@talentbridge.test', password: pw })).body.token;
      const tt = (await call('POST', '/auth/login', { email: 'talent5@talentbridge.test', password: pw })).body.token;
      const tid = (await call('GET', '/auth/me', null, tt)).body.user.id;
      const job = (await call('POST', '/jobs', { title: 'Install a 5 kW inverter', description: 'Supply and install inverter with battery, COC included.', category: 'Trades & Repairs', type: 'Freelance', province: 'Gauteng', city: 'Midrand', pay_min: 20000, pay_max: 40000, pay_unit: 'project' }, cl)).body.data;
      const cr = await call('POST', '/contracts', { job_id: job.id, talent_id: tid, amount: 31250, description: 'Inverter, battery and COC' }, cl);
      const c = cr.body.data;
      assert.equal((await call('POST', `/contracts/${c.id}/accept`, null, tt)).status, 200);
      const pay = (await call('POST', `/contracts/${c.id}/fund`, null, cl)).body;
      assert.equal(pay.mode, 'payfast'); assert.equal(pay.action, 'https://sandbox.payfast.co.za/eng/process');
      assert.equal(pay.fields.amount, (c.amount_cents / 100).toFixed(2)); assert.equal(pay.fields.m_payment_id, pay.reference);
      assert.ok(pay.fields.notify_url.endsWith('/api/webhooks/payfast')); assert.ok(pay.fields.return_url.includes('payment=return'));
      const { signature, ...unsigned } = pay.fields; assert.equal(signature, PF.checkoutSignature(unsigned, 'jt7NOE43FZPn'));
      // build an ITN the way PayFast sends one
      const itn = (over = {}) => {
        const d = { m_payment_id: pay.reference, pf_payment_id: '1089250', payment_status: 'COMPLETE', item_name: pay.fields.item_name, item_description: pay.fields.item_description,
          amount_gross: pay.fields.amount, amount_fee: '-720.36', amount_net: '30530.14', custom_str1: '', custom_int1: String(c.id), name_first: pay.fields.name_first, name_last: pay.fields.name_last || '',
          email_address: pay.fields.email_address, merchant_id: '10000100', ...over };
        const pairs = Object.entries(d); const sig = PF.md5(PF.itnParamString(pairs) + '&passphrase=jt7NOE43FZPn');
        return pairs.map(([k, v]) => `${k}=${PF.enc(v)}`).join('&') + '&signature=' + (over.__sig || sig);
      };
      const post = (body) => fetch(base + '/webhooks/payfast', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      assert.equal((await post(itn({ __sig: 'f'.repeat(32) }).replace('&__sig=' + 'f'.repeat(32), ''))).status, 400); // forged signature
      assert.equal((await post(itn({ amount_gross: '10.00' }))).status, 200); // valid signature, wrong amount: ignored
      assert.equal((await call('GET', `/contracts/${c.id}`, null, cl)).body.data.status, 'accepted');
      assert.equal((await post(itn())).status, 200);
      assert.equal((await call('GET', `/contracts/${c.id}`, null, cl)).body.data.status, 'funded');
      assert.equal((await post(itn())).status, 200); // repeated ITN is harmless
      const row = require('../src/db').prepare('SELECT * FROM payments WHERE reference = ?').get(pay.reference);
      assert.equal(row.status, 'paid'); assert.equal(row.provider_ref, '1089250'); assert.ok(row.paid_at);
    } finally { delete process.env.PAYMENTS_MODE; delete process.env.PAYFAST_SKIP_IP_CHECK; delete process.env.PAYFAST_SKIP_VALIDATE; }
  });
  await step('unknown API route returns JSON 404', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
  });
  server.close();
  console.log('All smoke tests passed');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
