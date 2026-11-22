/* TalentBridge motion: scroll reveals, counters, depth, magnetic buttons, card tilt, nav indicator, scroll progress.
   No libraries. Does nothing (beyond the static scroll bar) when the visitor prefers reduced motion. */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const wide = () => innerWidth > 1024;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const hd = $('#hd') || $('.hd') || $('.lh');

  /* ---------- scroll progress (useful even with reduced motion: it does not move content) ---------- */
  let prog = null;
  if (hd) { prog = document.createElement('i'); prog.className = 'prog'; prog.setAttribute('aria-hidden', 'true'); hd.append(prog); }

  /* ---------- one rAF loop for everything tied to scrolling ---------- */
  const hero = $('.hero'), photo = $('.hero-photo'), pulse = $('.theatre .pulse'), biz = $('.biz-img');
  let ticking = false;
  const onScroll = () => {
    ticking = false;
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    if (prog) prog.style.setProperty('--p', max > 0 ? Math.min(1, y / max).toFixed(4) : 0);
    if (reduce || !wide()) return;
    if (hero && y < innerHeight * 1.2) {
      photo?.style.setProperty('--py', (y * -0.07).toFixed(1));
      pulse?.style.setProperty('--py2', (y * -0.14).toFixed(1));
    }
    if (biz) {
      const r = biz.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) biz.style.setProperty('--py', (((r.top + r.height / 2) - innerHeight / 2) * -0.06).toFixed(1));
    }
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  addEventListener('resize', () => requestAnimationFrame(onScroll), { passive: true });
  onScroll();

  if (reduce) return;

  /* ---------- hero bridge: measure the arcs so they draw exactly once, then send a spark across ---------- */
  $$('.bridge path').forEach(p => { try { p.style.setProperty('--len', Math.ceil(p.getTotalLength())); } catch {} });
  const spark = $('.bridge .spark animateMotion');
  if (spark) setTimeout(() => { try { spark.beginElement(); $('.bridge .spark animate')?.beginElement(); } catch {} }, 2600);

  /* ---------- scroll reveals ---------- */
  const tag = (sel, val = '', delayStep = 0) => $$(sel).forEach((el, i) => {
    if (el.closest('.hero') || el.hasAttribute('data-rv')) return;
    el.setAttribute('data-rv', val);
    if (delayStep) el.style.setProperty('--d', (i % 4) * delayStep + 's');
  });
  // headings: observe the whole heading block (a fully masked heading can't be seen by the observer)
  $$('.blk-hd').forEach(h => { if (!h.closest('.hero')) h.setAttribute('data-rv', 'hd'); });
  $$('.feature').forEach(f => {
    const flip = f.classList.contains('flip');
    f.querySelector('.copy')?.setAttribute('data-rv', flip ? 'right' : 'left');
    const st = f.querySelector('.stage'); if (st) { st.setAttribute('data-rv', ''); st.style.setProperty('--d', '.1s'); st.setAttribute('data-st', ''); }
  });
  tag('.path-img, .biz-img, .cat-img', 'img');
  tag('.biz h2, .biz p, .escrow ul, .calc, .intl-copy, .contact > div, #cform, .compare, .morecats');
  ['#cats', '#people', '#provs', '#quotes', '.paths', '.faq', '.cta2', '.intl-steps', '.biz dl', '.escrow ul', 'footer .cols', '#facts', '.sk-chips', '#skl']
    .forEach(s => $$(s).forEach(el => { el.removeAttribute('data-rv'); el.setAttribute('data-st', ''); }));
  // job list rows are re-rendered on every search; let them stagger too
  $$('#joblist').forEach(el => el.setAttribute('data-st', ''));

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  const watch = () => $$('[data-rv]:not(.in), [data-st]:not(.in)').forEach(el => io.observe(el));
  watch();
  // anything the page adds later (lists, empty states) gets picked up
  new MutationObserver(() => { clearTimeout(watch.t); watch.t = setTimeout(watch, 60); }).observe(document.body, { childList: true, subtree: true });
  // safety net: never leave content hidden if an observer misses it (e.g. printing, odd scroll containers)
  addEventListener('beforeprint', () => $$('[data-rv], [data-st]').forEach(el => el.classList.add('in')));

  /* ---------- animated counters ---------- */
  const fmt = (n, dec) => n.toLocaleString('en-ZA', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const countUp = (el) => {
    if (el.dataset.counted) return; el.dataset.counted = '1';
    const raw = el.textContent.trim(), m = raw.match(/^(\D*?)([\d \s,]*\d(?:[.,]\d+)?)(.*)$/);
    if (!m) return;
    const numStr = m[2].replace(/[\s ]/g, '').replace(/,(?=\d{3}\b)/g, ''), dec = (numStr.split(/[.,]/)[1] || '').length;
    const target = parseFloat(numStr.replace(',', '.')); if (!isFinite(target) || target === 0) return;
    const t0 = performance.now(), dur = Math.min(1800, 900 + target * 2);
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      el.textContent = m[1] + fmt(target * e, dec) + m[3]; if (k < 1) requestAnimationFrame(step); else el.textContent = raw; };
    requestAnimationFrame(step);
  };
  const cio = new IntersectionObserver((es) => es.forEach(e => { if (e.isIntersecting) { $$('b', e.target).forEach(countUp); } }), { threshold: 0.4 });
  const facts = $('#facts');
  if (facts) { cio.observe(facts); new MutationObserver(() => { if (facts.getBoundingClientRect().top < innerHeight) $$('b', facts).forEach(countUp); }).observe(facts, { childList: true }); }

  if (!fine) return; // everything below follows the mouse

  /* ---------- hero: floating chips drift with the pointer ---------- */
  if (hero) hero.addEventListener('pointermove', (e) => {
    if (!wide()) return;
    const r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    $$('.chip-float', hero).forEach((c, i) => { c.style.setProperty('--mx', (x * (i ? -1 : 1)).toFixed(3)); c.style.setProperty('--my', (y * (i ? -1 : 1)).toFixed(3)); });
  });

  /* ---------- magnetic primary buttons ---------- */
  const magSel = '.hero .search .btn, .hd .acts .btn:not(.ghost), .blk-hd .btn, .paths .btn, .intl-copy .btn, .biz .btn, .start-cta .btn';
  document.addEventListener('pointermove', (e) => {
    const b = e.target.closest?.(magSel);
    $$('.magnetic.mg-on').forEach(x => { if (x !== b) { x.classList.remove('mg-on'); x.style.setProperty('--mgx', 0); x.style.setProperty('--mgy', 0); } });
    if (!b) return;
    b.classList.add('magnetic', 'mg-on');
    const r = b.getBoundingClientRect();
    b.style.setProperty('--mgx', ((e.clientX - r.left - r.width / 2) * .22).toFixed(1));
    b.style.setProperty('--mgy', ((e.clientY - r.top - r.height / 2) * .3).toFixed(1));
  }, { passive: true });

  /* ---------- cards tilt toward the pointer, with a soft light ---------- */
  const tiltSel = '.cat, .cta2 a, .person, .intl-steps li';
  let cur = null;
  const reset = (el) => { el.classList.remove('tilting'); el.style.setProperty('--rx', 0); el.style.setProperty('--ry', 0); };
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.(tiltSel);
    if (cur && cur !== el) { reset(cur); cur = null; }
    if (!el) return;
    cur = el; el.classList.add('tilt', 'tilting');
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const max = el.matches('.cta2 a') ? 3 : 5;
    el.style.setProperty('--ry', ((x - .5) * max * 2).toFixed(2));
    el.style.setProperty('--rx', ((.5 - y) * max * 2).toFixed(2));
    el.style.setProperty('--gx', (x * 100).toFixed(1) + '%'); el.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (cur) { reset(cur); cur = null; } });

  /* ---------- sliding indicator for the section you're reading ---------- */
  const nav = $('.hd nav');
  if (nav && hd?.id === 'hd') {
    const ind = document.createElement('span'); ind.className = 'ind'; ind.setAttribute('aria-hidden', 'true'); nav.prepend(ind);
    const links = $$('a[href^="#"]', nav), secs = links.map(a => $(a.getAttribute('href'))).filter(Boolean);
    const move = (a) => {
      links.forEach(l => l.classList.toggle('on', l === a));
      if (!a || getComputedStyle(nav).position === 'absolute') { nav.classList.remove('has-ind'); return; }
      nav.style.setProperty('--x', a.offsetLeft + 'px'); nav.style.setProperty('--w', a.offsetWidth + 'px'); nav.classList.add('has-ind');
    };
    const vis = new Map();
    const sio = new IntersectionObserver((es) => {
      es.forEach(e => vis.set(e.target, e.isIntersecting ? e.intersectionRatio : 0));
      let best = null, ratio = 0; vis.forEach((v, k) => { if (v > ratio) { ratio = v; best = k; } });
      move(best ? links.find(l => l.getAttribute('href') === '#' + best.id) : null);
    }, { threshold: [0, .15, .3, .5], rootMargin: '-72px 0px -40% 0px' });
    secs.forEach(s => sio.observe(s));
    addEventListener('resize', () => move(links.find(l => l.classList.contains('on'))), { passive: true });
  }
})();
