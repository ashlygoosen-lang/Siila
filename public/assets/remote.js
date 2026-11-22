(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const st = { q: '', category: '', region: 'sa', page: 1, cur: 'ZAR' };
  let FX = null, sources = [], first = true;

  /* ---------- working-hours overlap: South Africa against the cities that hire remotely ---------- */
  const CITIES = [['London', 'Europe/London'], ['Berlin', 'Europe/Berlin'], ['Lagos', 'Africa/Lagos'], ['Dubai', 'Asia/Dubai'], ['New York', 'America/New_York'], ['Sydney', 'Australia/Sydney']];
  const SA = { start: 8, end: 17 };
  const offsetH = (tz, d = new Date()) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(d).map(x => [x.type, x.value]));
    const utcMin = Math.floor(d.getTime() / 60000) * 60000;
    return Math.round((Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute) - utcMin) / 9e5) / 4;
  };
  const clock = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  // Their 09:00–17:00 expressed in South African time, split where it wraps past midnight.
  const segs = (rel) => { const a = ((9 - rel) % 24 + 24) % 24, b = a + 8; return b <= 24 ? [[a, b]] : [[a, 24], [0, b - 24]]; };
  const overlap = (ss) => ss.reduce((t, [a, b]) => t + Math.max(0, Math.min(b, SA.end) - Math.max(a, SA.start)), 0);
  const pct = (h) => (h / 24 * 100).toFixed(3) + '%';

  function drawTz() {
    const sa = offsetH('Africa/Johannesburg');
    $('#tz').innerHTML = `<div class="tz-sa" style="--a:${SA.start / 24};--w:${(SA.end - SA.start) / 24}" aria-hidden="true"></div>` + CITIES.map(([name, tz], i) => {
      const ss = segs(offsetH(tz) - sa), ov = overlap(ss);
      const bars = ss.map(([a, b]) => {
        const oa = Math.max(a, SA.start), ob = Math.min(b, SA.end);
        return `<i class="bar" style="left:${pct(a)};width:${pct(b - a)}"></i>` + (ob > oa ? `<i class="ov" style="left:${pct(oa)};width:${pct(ob - oa)}"></i>` : '');
      }).join('');
      const label = ov >= 1 ? `${ov % 1 ? ov.toFixed(1) : ov} h shared` : 'Async';
      return `<div class="tz-row" role="listitem" style="--i:${i}" aria-label="${esc(name)}: ${esc(label)} with South African office hours">
        <div class="tz-city"><b>${esc(name)}</b><span data-clock="${tz}">${clock(tz)}</span></div>
        <div class="tz-track">${bars}</div><div class="tz-ov ${ov >= 4 ? 'good' : ''}">${label}</div></div>`;
    }).join('') + '<div class="tz-now" id="tzLine" aria-hidden="true"><span></span></div>';
    tick();
  }
  function tick() {
    const [hh, mm] = clock('Africa/Johannesburg').split(':').map(Number);
    const line = $('#tzLine'); if (line) { line.style.setProperty('--x', ((hh + mm / 60) / 24).toFixed(4)); line.querySelector('span').textContent = clock('Africa/Johannesburg'); }
    $$('[data-clock]').forEach(el => { el.textContent = clock(el.dataset.clock); });
    $('#tzNow').textContent = `Now in South Africa: ${clock('Africa/Johannesburg')}`;
  }

  /* ---------- live numbers ---------- */
  function countTo(el, n) {
    if (calm || !n) { el.textContent = n.toLocaleString('en-ZA'); return; }
    const t0 = performance.now(), dur = 1200;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4); el.textContent = Math.round(n * e).toLocaleString('en-ZA'); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  /* ---------- currency ---------- */
  const REGION_CUR = { US: 'USD', GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
    CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', AE: 'AED', SA: 'SAR', IN: 'INR', CN: 'CNY', JP: 'JPY', SG: 'SGD', HK: 'HKD', NG: 'NGN', KE: 'KES', GH: 'GHS',
    EG: 'EGP', MA: 'MAD', BW: 'BWP', NA: 'NAD', ZM: 'ZMW', MZ: 'MZN', BR: 'BRL', MX: 'MXN', ZA: 'ZAR' };
  try { st.cur = localStorage.getItem('tb_cur') || REGION_CUR[(navigator.language.split('-')[1] || '').toUpperCase()] || 'ZAR'; } catch { /* storage unavailable */ }
  const fmt = (amount, cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: amount < 100 ? 2 : 0 }).format(amount); } catch { return cur + ' ' + Math.round(amount).toLocaleString('en'); } };
  const conv = (rand) => (!FX || st.cur === 'ZAR' || !FX.rates[st.cur]) ? '' : fmt(rand * FX.rates[st.cur], st.cur);
  const ago = (iso) => { const d = (Date.now() - Date.parse(iso)) / 864e5; return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? Math.floor(d) + ' days ago' : new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); };
  const UNIT = { hour: 'an hour', day: 'a day', month: 'a month', project: 'for the project' };
  const initials = (n) => String(n || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '•';
  const hue = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

  /* ---------- cards ---------- */
  const tbCard = (j, i) => {
    const lo = conv(j.pay_min), hi = conv(j.pay_max);
    return `<a class="rm-job tb" href="/app.html#job/${j.id}" style="--i:${Math.min(i, 8)}">
      <span class="rm-mark tbm" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M12 42c6-11 13-16 20-16s14 5 20 16" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><path d="M10 50h44" stroke="#f5b935" stroke-width="6" stroke-linecap="round"/></svg></span>
      <div class="rm-main"><h3>${esc(j.title)}</h3><div class="rm-meta"><span class="rm-co">${j.company_country ? 'Company in ' + esc(j.company_country) : 'Remote'}</span><span>${esc(j.category)}</span><span>${j.bids} bid${j.bids === 1 ? '' : 's'}</span></div>
        ${j.excerpt ? `<p>${esc(j.excerpt)}</p>` : ''}</div>
      <div class="rm-side"><b>${esc(j.pay_label)}</b>${lo ? `<small>≈ ${lo}${hi && hi !== lo ? '–' + hi : ''} ${esc(UNIT[j.pay_unit] || '')}</small>` : ''}
        ${j.escrow_funded ? '<span class="rm-badge">Escrow funded</span>' : ''}<span class="rm-go">View and bid <span aria-hidden="true">→</span></span></div></a>`;
  };
  const pCard = (j, i) => `<article class="rm-job" style="--i:${Math.min(i, 8)}">
      <span class="rm-mark" style="--h:${hue(j.company)}" aria-hidden="true">${esc(initials(j.company))}</span>
      <div class="rm-main"><h3>${esc(j.title)}</h3><div class="rm-meta"><span class="rm-co">${esc(j.company)}</span><span>${esc(j.region || 'Remote')}</span>${j.job_type ? `<span>${esc(j.job_type)}</span>` : ''}<span>${ago(j.published_at)}</span></div>
        ${j.excerpt ? `<p>${esc(j.excerpt)}</p>` : ''}<small class="rm-src">Listed on <a href="${esc(j.source_site)}" target="_blank" rel="noopener">${esc(j.source_name)}</a></small></div>
      <div class="rm-side">${j.salary ? `<b class="sal">${esc(j.salary)}</b>` : ''}<a class="btn sm" href="${esc(j.url)}" target="_blank" rel="noopener nofollow">Apply on ${esc(j.source_name)} <span aria-hidden="true">↗</span></a></div></article>`;
  const skel = (n) => Array.from({ length: n }, () => '<div class="rm-skel"></div>').join('');

  function drawCats(cats) {
    const total = cats.reduce((t, c) => t + c.n, 0);
    $('#rmCats').innerHTML = [['', 'All', total], ...cats.map(c => [c.category, c.category, c.n])]
      .map(([v, l, n]) => `<button type="button" class="cat" data-cat="${esc(v)}" aria-pressed="${v === st.category}">${esc(l)} <span>${n}</span></button>`).join('');
  }
  function drawHiring(names) {
    const wrap = $('.rm-hiring');
    if (names.length < 4) { wrap.hidden = true; return; }
    const one = names.map(n => `<span class="hc"><i style="--h:${hue(n)}">${esc(initials(n))}</i>${esc(n)}</span>`).join('');
    $('#hiring').innerHTML = `<span class="set">${one}</span><span class="set" aria-hidden="true">${one}</span>`;
    $('#hiring').style.setProperty('--dur', Math.max(40, names.length * 3.5) + 's');
    wrap.hidden = false;
  }
  const reveal = () => { const els = $$('.rm-job:not(.shown)'); if (calm) els.forEach(el => el.classList.add('shown')); else requestAnimationFrame(() => requestAnimationFrame(() => els.forEach(el => el.classList.add('shown')))); };

  async function load(append = false) {
    const p = new URLSearchParams({ region: st.region, page: st.page });
    if (st.q) p.set('q', st.q); if (st.category) p.set('category', st.category);
    const list = $('#pList');
    if (!append && !first) list.innerHTML = skel(3);
    let d;
    try { d = await (await fetch('/api/remote?' + p)).json(); } catch { $('#pCount').textContent = 'Remote jobs couldn’t load. Check your connection and try again.'; list.innerHTML = ''; return; }
    sources = d.sources || sources;
    if (!append) {
      $('#laneTb').hidden = !d.talentbridge.length;
      $('#tbList').innerHTML = d.talentbridge.map(tbCard).join('');
      drawCats(d.categories);
      if (first) {
        drawHiring(d.hiring || []);
        if (d.stats) {
          $$('[data-stat]').forEach(el => countTo(el, d.stats[el.dataset.stat] || 0));
          if (d.stats.open_to_sa) $('#liveLine').textContent = `${d.stats.open_to_sa.toLocaleString('en-ZA')} remote jobs open to South Africa right now`;
        }
      }
    }
    const m = d.partners.meta;
    $('#pCount').textContent = m.total
      ? `${m.total.toLocaleString('en-ZA')} remote job${m.total === 1 ? '' : 's'}${st.region === 'sa' ? ' open to people in South Africa' : ''}${st.category ? ' in ' + st.category : ''}. You apply on the original job board.`
      : (st.q || st.category ? 'No partner listings match. Try fewer words, another category or “All locations”.' : 'Partner listings refresh a few times a day. Check back soon.');
    const base = append ? list.children.length : 0;
    const html = d.partners.data.map(pCard).join('');
    if (append) list.insertAdjacentHTML('beforeend', html); else list.innerHTML = html;
    reveal();
    $('#more').hidden = m.page >= m.pages;
    if (append && list.children[base]) list.children[base].querySelector('a.btn')?.focus({ preventScroll: true });
    credit();
    first = false;
  }

  function credit() {
    $('#credit').innerHTML = (sources.length ? `Partner listings come from ${sources.map(s => `<a href="${esc(s.site)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(', ')}. Always check a job on the original site before you share personal details. ` : '')
      + (FX ? (FX.live ? `Currency conversions are for reference: <a href="${esc(FX.source.url)}" target="_blank" rel="noopener">${esc(FX.source.label)}</a>. ` : 'Currency conversions are approximate. ') + 'Payments on TalentBridge are charged in South African rand.' : '');
  }

  async function init() {
    drawTz(); setInterval(tick, 30000);
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('rm-ready')));
    try { FX = await (await fetch('/api/fx')).json(); } catch { FX = null; }
    const cs = $('#rmf [name=cur]');
    const curs = FX ? Object.entries(FX.currencies) : [['ZAR', ['South African rand']]];
    cs.innerHTML = curs.map(([k, v]) => `<option value="${k}"${k === st.cur ? ' selected' : ''}>${k} · ${esc(v[0])}</option>`).join('');
    if (!FX?.rates?.[st.cur]) { st.cur = 'ZAR'; cs.value = 'ZAR'; }
    cs.onchange = () => { st.cur = cs.value; try { localStorage.setItem('tb_cur', st.cur); } catch { /* ignore */ } st.page = 1; load(); };
    $('#rmf').onsubmit = (e) => { e.preventDefault(); st.q = e.target.q.value.trim(); st.page = 1; load(); };
    $('#rmCats').onclick = (e) => { const b = e.target.closest('.cat'); if (!b) return; st.category = b.dataset.cat; st.page = 1; load(); };
    $$('.rm-tabs .chip').forEach(b => b.onclick = () => {
      st.region = b.dataset.region; st.category = ''; st.page = 1;
      $$('.rm-tabs .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      load();
    });
    $('#more').onclick = () => { st.page++; load(true); };
    // the search bar gains a surface once it sticks under the header
    const bar = $('#rmf'), sentinel = document.createElement('div');
    sentinel.style.height = '1px'; bar.before(sentinel);
    new IntersectionObserver(([e]) => bar.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < 80), { rootMargin: '-66px 0px 0px 0px' }).observe(sentinel);
    load();
  }
  init();
})();
