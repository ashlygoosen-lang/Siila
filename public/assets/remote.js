(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = { q: '', category: '', region: 'sa', page: 1, cur: 'ZAR' };
  let FX = null, sources = [];

  // Guess the visitor's currency from their browser's region; they can change it.
  const REGION_CUR = { US: 'USD', GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
    CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', AE: 'AED', SA: 'SAR', IN: 'INR', CN: 'CNY', JP: 'JPY', SG: 'SGD', HK: 'HKD', NG: 'NGN', KE: 'KES', GH: 'GHS',
    EG: 'EGP', MA: 'MAD', BW: 'BWP', NA: 'NAD', ZM: 'ZMW', MZ: 'MZN', BR: 'BRL', MX: 'MXN', ZA: 'ZAR' };
  try { st.cur = localStorage.getItem('tb_cur') || REGION_CUR[(navigator.language.split('-')[1] || '').toUpperCase()] || 'ZAR'; } catch { /* storage unavailable */ }

  const fmt = (amount, cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: amount < 100 ? 2 : 0 }).format(amount); } catch { return cur + ' ' + Math.round(amount).toLocaleString('en'); } };
  const conv = (rand) => (!FX || st.cur === 'ZAR' || !FX.rates[st.cur]) ? '' : fmt(rand * FX.rates[st.cur], st.cur);
  const ago = (iso) => { const d = (Date.now() - Date.parse(iso)) / 864e5; return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? Math.floor(d) + ' days ago' : new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); };
  const UNIT = { hour: 'an hour', day: 'a day', month: 'a month', project: 'for the project' };

  const tbCard = (j) => {
    const lo = conv(j.pay_min), hi = conv(j.pay_max);
    return `<a class="rm-job tb" href="/app.html#job/${j.id}">
      <div class="rm-main"><h3>${esc(j.title)}</h3><div class="rm-meta"><span>${j.company_country ? 'Company in ' + esc(j.company_country) : 'Remote'}</span><span>${esc(j.category)}</span><span>${j.bids} bid${j.bids === 1 ? '' : 's'}</span></div>
        ${j.excerpt ? `<p>${esc(j.excerpt)}</p>` : ''}</div>
      <div class="rm-side"><b>${esc(j.pay_label)}</b>${lo ? `<small>≈ ${lo}${hi && hi !== lo ? '–' + hi : ''} ${esc(UNIT[j.pay_unit] || '')}</small>` : ''}
        ${j.escrow_funded ? '<span class="rm-badge">Escrow funded</span>' : ''}<span class="rm-go">View and bid</span></div></a>`;
  };
  const pCard = (j) => `<article class="rm-job">
      <div class="rm-main"><h3>${esc(j.title)}</h3><div class="rm-meta"><span>${esc(j.company)}</span><span>${esc(j.region || 'Remote')}</span>${j.job_type ? `<span>${esc(j.job_type)}</span>` : ''}<span>${ago(j.published_at)}</span></div>
        ${j.excerpt ? `<p>${esc(j.excerpt)}</p>` : ''}<small class="rm-src">Listed on <a href="${esc(j.source_site)}" target="_blank" rel="noopener">${esc(j.source_name)}</a></small></div>
      <div class="rm-side">${j.salary ? `<b class="sal">${esc(j.salary)}</b>` : ''}<a class="btn sm" href="${esc(j.url)}" target="_blank" rel="noopener nofollow">Apply on ${esc(j.source_name)} ↗</a></div></article>`;

  async function load(append = false) {
    const p = new URLSearchParams({ region: st.region, page: st.page });
    if (st.q) p.set('q', st.q); if (st.category) p.set('category', st.category);
    let d;
    try { d = await (await fetch('/api/remote?' + p)).json(); } catch { $('#pCount').textContent = 'Remote jobs couldn’t load. Check your connection and try again.'; return; }
    sources = d.sources || sources;
    if (!append) {
      $('#laneTb').hidden = !d.talentbridge.length;
      $('#tbList').innerHTML = d.talentbridge.map(tbCard).join('');
      const sel = $('#rmf [name=category]'), keep = sel.value;
      sel.innerHTML = '<option value="">All categories</option>' + d.categories.map(c => `<option value="${esc(c.category)}">${esc(c.category)} (${c.n})</option>`).join('');
      if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    }
    const m = d.partners.meta;
    $('#pCount').textContent = m.total
      ? `${m.total.toLocaleString('en-ZA')} remote job${m.total === 1 ? '' : 's'}${st.region === 'sa' ? ' open to people in South Africa' : ''}. You apply on the original job board.`
      : (st.q || st.category ? 'No partner listings match your search. Try fewer words or another category.' : 'Partner listings refresh a few times a day. Check back soon.');
    const html = d.partners.data.map(pCard).join('');
    if (append) $('#pList').insertAdjacentHTML('beforeend', html); else $('#pList').innerHTML = html;
    $('#more').hidden = m.page >= m.pages;
    credit();
  }

  function credit() {
    $('#credit').innerHTML = (sources.length ? `Partner listings come from ${sources.map(s => `<a href="${esc(s.site)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(', ')}. Always check a job on the original site before you share personal details. ` : '')
      + (FX ? (FX.live ? `Currency conversions are for reference: <a href="${esc(FX.source.url)}" target="_blank" rel="noopener">${esc(FX.source.label)}</a>. ` : 'Currency conversions are approximate. ') + 'Payments on TalentBridge are charged in South African rand.' : '');
  }

  async function init() {
    try { FX = await (await fetch('/api/fx')).json(); } catch { FX = null; }
    const cs = $('#rmf [name=cur]');
    const curs = FX ? Object.entries(FX.currencies) : [['ZAR', ['South African rand']]];
    cs.innerHTML = curs.map(([k, v]) => `<option value="${k}"${k === st.cur ? ' selected' : ''}>${k} · ${esc(v[0])}</option>`).join('');
    if (!FX?.rates?.[st.cur]) { st.cur = 'ZAR'; cs.value = 'ZAR'; }
    cs.onchange = () => { st.cur = cs.value; try { localStorage.setItem('tb_cur', st.cur); } catch { /* ignore */ } st.page = 1; load(); };
    $('#rmf').onsubmit = (e) => { e.preventDefault(); const f = e.target; st.q = f.q.value.trim(); st.category = f.category.value; st.page = 1; load(); };
    $('#rmf [name=category]').onchange = (e) => { st.category = e.target.value; st.page = 1; load(); };
    document.querySelectorAll('.rm-tabs .chip').forEach(b => b.onclick = () => {
      st.region = b.dataset.region; st.page = 1;
      document.querySelectorAll('.rm-tabs .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      load();
    });
    $('#more').onclick = () => { st.page++; load(true); };
    load();
  }
  init();
})();
