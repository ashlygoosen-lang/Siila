// Remote jobs board: TalentBridge's own escrow-funded remote jobs first, then live listings from partner job boards
// (credited, linking to the original posting). Public: no sign-up is needed to browse.
const router = require('express').Router();
const db = require('../db');
const { auth, requireRole, validate, z, HttpError } = require('../util');
const F = require('../remotefeed');
const { byOfo } = require('../skills');

const tbShape = (j) => {
  const { shape } = require('./jobs');
  const s = shape(j);
  return { kind: 'talentbridge', id: s.id, title: s.title, company: '', company_country: s.company_country, category: s.category, type: s.type, pay_label: s.pay_label,
    pay_min: s.pay_min, pay_max: s.pay_max, pay_unit: s.pay_unit, escrow_funded: s.escrow_funded, escrow_cents: j.escrow_required ? j.escrow_cents : 0,
    excerpt: F.text(j.description, 240), bids: s.bids, created_at: s.created_at, url: `/app.html#job/${s.id}` };
};
const feedShape = (r) => ({ kind: 'partner', id: r.id, source: r.source, source_name: F.SOURCES[r.source]?.name || r.source, source_site: F.SOURCES[r.source]?.site || '',
  url: r.url, title: r.title, company: r.company, category: r.category, job_type: r.job_type, region: r.region, open_to_sa: !!r.open_to_sa, salary: r.salary,
  tags: r.tags ? r.tags.split(', ') : [], excerpt: r.excerpt, published_at: r.published_at });

const q = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(40).optional(),
  region: z.enum(['sa', 'all']).default('sa'),
  source: z.enum(['all', 'talentbridge', 'partners']).default('all'),
  page: z.coerce.number().int().min(1).max(200).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/remote', validate(q, 'query'), (req, res) => {
  const { q: term, category, region, source, page, limit } = req.q;
  const like = term ? `%${term}%` : null;
  let tb = [];
  if (source !== 'partners' && page === 1) {
    const w = ["status = 'open'", 'remote = 1'], a = [];
    if (like) { w.push('(title LIKE ? OR description LIKE ? OR category LIKE ?)'); a.push(like, like, like); }
    if (category) { w.push('category = ?'); a.push(category); }
    tb = db.prepare(`SELECT * FROM jobs WHERE ${w.join(' AND ')} ORDER BY (escrow_required = 1 AND funded_at IS NOT NULL) DESC, featured DESC, created_at DESC LIMIT 50`).all(...a).map(tbShape);
  }
  let partners = { data: [], meta: { page, limit, total: 0, pages: 0 } };
  if (source !== 'talentbridge') {
    const w = ['1 = 1'], a = [];
    if (region === 'sa') w.push('open_to_sa = 1');
    if (like) { w.push('(title LIKE ? OR company LIKE ? OR tags LIKE ? OR excerpt LIKE ?)'); a.push(like, like, like, like); }
    if (category) { w.push('category = ?'); a.push(category); }
    const total = db.prepare(`SELECT COUNT(*) n FROM feed_jobs WHERE ${w.join(' AND ')}`).get(...a).n;
    const rows = db.prepare(`SELECT * FROM feed_jobs WHERE ${w.join(' AND ')} ORDER BY published_at DESC LIMIT ? OFFSET ?`).all(...a, limit, (page - 1) * limit);
    partners = { data: rows.map(feedShape), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
  }
  const stats = { open_to_sa: db.prepare('SELECT COUNT(*) n FROM feed_jobs WHERE open_to_sa = 1').get().n + db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'open' AND remote = 1").get().n,
    total: db.prepare('SELECT COUNT(*) n FROM feed_jobs').get().n, companies: db.prepare("SELECT COUNT(DISTINCT company) n FROM feed_jobs WHERE company != ''").get().n,
    funded: db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'open' AND remote = 1 AND escrow_required = 1 AND funded_at IS NOT NULL").get().n };
  const hiring = db.prepare(`SELECT company FROM feed_jobs WHERE company != '' ${region === 'sa' ? 'AND open_to_sa = 1' : ''} GROUP BY company ORDER BY MAX(published_at) DESC LIMIT 24`).all().map(r => r.company);
  const cats = db.prepare(`SELECT category, COUNT(*) n FROM feed_jobs ${region === 'sa' ? 'WHERE open_to_sa = 1' : ''} GROUP BY category ORDER BY n DESC`).all();
  res.set('Cache-Control', 'no-cache');
  res.json({ talentbridge: tb, partners, categories: cats, stats, hiring, sources: Object.entries(F.SOURCES).map(([k, s]) => ({ key: k, name: s.name, site: s.site })) });
});

router.get('/fx', (_req, res) => {
  const FX = require('../fx');
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ ...FX.rates(), currencies: FX.CURRENCIES });
});

// Suggested remote jobs for a professional: scored against their skills, headline and occupation.
const STOP = new Set(['and', 'the', 'for', 'with', 'senior', 'junior', 'remote', 'manager', 'lead', 'specialist', 'officer', 'assistant', 'work', 'from', 'home']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9+#.]+/).filter(w => w.length > 2 && !STOP.has(w));
router.get('/remote/suggestions', auth(), requireRole('talent'), (req, res) => {
  const p = db.prepare('SELECT skills, headline, occupation_ofo, country, residency FROM profiles WHERE user_id = ?').get(req.user.id);
  if (!p) throw new HttpError(404, 'Complete your profile to get suggestions');
  let skills = []; try { skills = JSON.parse(p.skills || '[]').map(s => String(s).toLowerCase()).filter(Boolean); } catch { /* ignore */ }
  const occ = byOfo(p.occupation_ofo)?.name || '';
  const phrases = [...new Set([...skills, occ.toLowerCase()].filter(Boolean))];
  const vocab = new Set([...words(p.headline), ...words(occ), ...skills.flatMap(words)]);
  if (!phrases.length && !vocab.size) return res.json({ talentbridge: [], partners: [], hint: 'Add skills and a headline to your profile and we’ll suggest remote jobs that fit.' });
  const score = (title, body) => {
    const t = `${title} ${body}`.toLowerCase(), why = [];
    let s = 0;
    for (const ph of phrases) if (ph.length > 1 && t.includes(ph)) { s += String(title).toLowerCase().includes(ph) ? 5 : 3; why.push(ph); }
    for (const w of new Set(words(title))) if (vocab.has(w)) s += 2;
    return { s, why: why.slice(0, 3) };
  };
  const inSA = !p.country || /south africa/i.test(p.country) || p.residency !== 'foreign';
  const tb = db.prepare("SELECT * FROM jobs WHERE status = 'open' AND remote = 1 ORDER BY created_at DESC LIMIT 400").all()
    .map(j => ({ j, ...score(j.title, `${j.category} ${j.description}`) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6)
    .map(x => ({ ...tbShape(x.j), match: x.s, why: x.why }));
  const partners = db.prepare(`SELECT * FROM feed_jobs ${inSA ? 'WHERE open_to_sa = 1' : ''} ORDER BY published_at DESC LIMIT 1500`).all()
    .map(r => ({ r, ...score(r.title, `${r.tags} ${r.category} ${r.excerpt}`) })).filter(x => x.s > 1).sort((a, b) => b.s - a.s || b.r.published_at.localeCompare(a.r.published_at)).slice(0, 8)
    .map(x => ({ ...feedShape(x.r), match: x.s, why: x.why }));
  res.json({ talentbridge: tb, partners });
});

// Admin: see each partner board's status and refresh now.
router.get('/admin/remote-feeds', auth(), requireRole('admin'), (_req, res) => res.json({ data: F.status() }));
router.post('/admin/remote-feeds/refresh', auth(), requireRole('admin'), async (_req, res) => res.json({ data: await F.refresh(true) }));

module.exports = router;
