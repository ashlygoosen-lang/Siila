// Remote jobs from partner job boards, shown next to TalentBridge's own escrow-funded remote jobs.
// Each board's terms are followed: every listing names its source and links to the original posting for applying,
// nothing is hidden behind sign-up, listings are not passed on to other job sites, and each board is polled at most
// four times a day (Remotive asks for no more than four requests a day; Jobicy no more than hourly).
const db = require('./db');

const UA = 'TalentBridge remote jobs (talentbridge.co.za)';
const EVERY_MS = 6 * 3600 * 1000;
const KEEP_DAYS = 45;

const SOURCES = {
  remotive: { name: 'Remotive', site: 'https://remotive.com', terms: 'https://github.com/remotive-com/remote-jobs-api' },
  jobicy: { name: 'Jobicy', site: 'https://jobicy.com', terms: 'https://jobicy.com/jobs-rss-feed' },
  arbeitnow: { name: 'Arbeitnow', site: 'https://www.arbeitnow.com', terms: 'https://www.arbeitnow.com/blog/job-board-api' },
};

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
function text(html, max = 280) {
  const t = String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
}
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : ''; } catch { return ''; } };

// Can someone living in South Africa take this job? Based on the board's location text.
function openToSA(region) {
  const r = String(region || '').toLowerCase();
  if (!r) return 0;
  return /worldwide|anywhere|global|world|africa|emea|international|all countries|any location|everywhere/.test(r) ? 1 : 0;
}

// Group the boards' many category names into a short list people can filter by.
const GROUPS = [
  ['Software & IT', /software|develop|engineer|devops|programm|\bit\b|\bqa\b|testing|sysadmin|cloud|security|backend|frontend|full.?stack|mobile|web/i],
  ['Data & AI', /data|machine learning|\bai\b|analytics|scien/i],
  ['Design & Creative', /design|creative|ux|ui\b|graphic|video|multimedia|illustrat|art\b/i],
  ['Marketing & Sales', /marketing|seo|sales|growth|business develop|advertis|social media|account exec/i],
  ['Writing & Content', /writ|content|copy|editor|translat|journal/i],
  ['Customer Support', /support|customer|success|service|help ?desk/i],
  ['Finance & Admin', /financ|account|admin|assistant|legal|operations|bookkeep|payroll|virtual/i],
  ['HR & Recruiting', /\bhr\b|human resources|recruit|talent|people/i],
  ['Education', /educat|teach|tutor|training/i],
  ['Healthcare', /health|medical|nurs|clinic/i],
  ['Product & Project', /product|project|scrum|agile|program manag/i],
];
const groupOf = (...parts) => { const s = parts.join(' '); return (GROUPS.find(([, re]) => re.test(s)) || ['Other'])[0]; };
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).replace(/&amp;/g, '&')).filter(Boolean);

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const FETCH = {
  async remotive() {
    const j = await getJson('https://remotive.com/api/remote-jobs?limit=300');
    return (j.jobs || []).map(x => ({
      id: `remotive:${x.id}`, url: x.url, title: x.title, company: x.company_name, category: groupOf(x.category, x.title), job_type: String(x.job_type || '').replace(/_/g, ' '),
      region: x.candidate_required_location || '', salary: x.salary || '', tags: list(x.tags).slice(0, 8), excerpt: text(x.description), published_at: x.publication_date,
    }));
  },
  async jobicy() {
    const j = await getJson('https://jobicy.com/api/v2/remote-jobs?count=100');
    return (j.jobs || []).map(x => {
      const sal = x.salaryMin ? `${x.salaryCurrency || ''} ${Number(x.salaryMin).toLocaleString('en')}${x.salaryMax ? '–' + Number(x.salaryMax).toLocaleString('en') : ''}${x.salaryPeriod ? ' per ' + x.salaryPeriod : ''}`.trim() : '';
      return { id: `jobicy:${x.id}`, url: x.url, title: text(x.jobTitle, 200), company: text(x.companyName, 120), category: groupOf(list(x.jobIndustry).join(' '), x.jobTitle),
        job_type: list(x.jobType).join(', '), region: x.jobGeo || '', salary: sal, tags: list(x.jobIndustry).slice(0, 4), excerpt: text(x.jobExcerpt || x.jobDescription), published_at: x.pubDate };
    });
  },
  async arbeitnow() {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const j = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
      for (const x of j.data || []) if (x.remote === true) out.push({
        id: `arbeitnow:${x.slug}`, url: x.url, title: x.title, company: x.company_name, category: groupOf(list(x.tags).join(' '), x.title), job_type: list(x.job_types).join(', '),
        region: x.location ? `${x.location} (remote)` : 'Remote', salary: '', tags: list(x.tags).slice(0, 8), excerpt: text(x.description),
        published_at: x.created_at ? new Date(Number(x.created_at) * 1000).toISOString() : new Date().toISOString(),
      });
      if (!j.links?.next) break;
      await new Promise(r => setTimeout(r, 1200));
    }
    return out;
  },
};

const upsert = db.prepare(`INSERT INTO feed_jobs (id, source, url, title, company, category, job_type, region, open_to_sa, salary, tags, excerpt, published_at, seen_at)
  VALUES (@id, @source, @url, @title, @company, @category, @job_type, @region, @open_to_sa, @salary, @tags, @excerpt, @published_at, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET url=excluded.url, title=excluded.title, company=excluded.company, category=excluded.category, job_type=excluded.job_type, region=excluded.region,
    open_to_sa=excluded.open_to_sa, salary=excluded.salary, tags=excluded.tags, excerpt=excluded.excerpt, seen_at=excluded.seen_at`);

/** Store one board's latest batch and drop its listings that are no longer live. */
function store(source, rows) {
  const clean = rows.map(r => ({
    id: clip(r.id, 200), source, url: httpsUrl(r.url), title: clip(text(r.title, 200), 200), company: clip(text(r.company, 120), 120), category: r.category || 'Other',
    job_type: clip(r.job_type, 60), region: clip(text(r.region, 160), 160), open_to_sa: openToSA(r.region), salary: clip(text(r.salary, 80), 80),
    tags: clip(list(r.tags).map(t => text(t, 40)).join(', '), 300), excerpt: clip(r.excerpt, 300),
    published_at: isNaN(Date.parse(r.published_at)) ? new Date().toISOString() : new Date(r.published_at).toISOString(),
  })).filter(r => r.url && r.title);
  db.transaction(() => {
    for (const r of clean) upsert.run(r);
    if (clean.length) db.prepare(`DELETE FROM feed_jobs WHERE source = ? AND id NOT IN (${clean.map(() => '?').join(',')})`).run(source, ...clean.map(r => r.id));
    db.prepare("DELETE FROM feed_jobs WHERE published_at < ?").run(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
  })();
  return clean.length;
}

const lastRun = (s) => db.prepare('SELECT value FROM cache_kv WHERE key = ?').get('feed:' + s)?.value;
const setRun = (s, v) => db.prepare("INSERT INTO cache_kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run('feed:' + s, JSON.stringify(v));

/** Refresh every board whose last fetch is older than six hours (or all of them, when forced). */
async function refresh(force = false) {
  const report = {};
  for (const s of Object.keys(SOURCES)) {
    const prev = (() => { try { return JSON.parse(lastRun(s) || 'null'); } catch { return null; } })();
    if (!force && prev?.at && Date.now() - Date.parse(prev.at) < EVERY_MS) { report[s] = { skipped: true, ...prev }; continue; }
    try {
      const n = store(s, await FETCH[s]());
      report[s] = { ok: true, count: n, at: new Date().toISOString() };
    } catch (e) {
      report[s] = { ok: false, error: e.message, at: new Date().toISOString(), count: prev?.count || 0 };
      console.warn(`Remote job feed ${s} failed:`, e.message);
    }
    setRun(s, report[s]);
  }
  return report;
}

function status() {
  return Object.fromEntries(Object.keys(SOURCES).map(s => {
    let r = null; try { r = JSON.parse(lastRun(s) || 'null'); } catch { /* ignore */ }
    return [s, { ...SOURCES[s], ...(r || {}), live: db.prepare('SELECT COUNT(*) n FROM feed_jobs WHERE source = ?').get(s).n }];
  }));
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.REMOTE_FEEDS === 'false') return;
  setTimeout(() => refresh().catch(() => {}), 20000).unref();
  timer = setInterval(() => refresh().catch(() => {}), 3600 * 1000);
  timer.unref();
}

module.exports = { SOURCES, GROUPS: [...GROUPS.map(g => g[0]), 'Other'], openToSA, groupOf, text, store, refresh, status, start };
