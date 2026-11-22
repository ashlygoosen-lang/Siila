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

  /* ---------- intro veil: remove it from the page once it has lifted ---------- */
  const veil = $('.intro-veil');
  if (veil) setTimeout(() => { veil.remove(); document.documentElement.classList.remove('intro'); }, document.documentElement.classList.contains('intro') ? 2100 : 0);

  /* ---------- skills ticker (filled from the live skills catalogue) ---------- */
  const tk1 = $('#tk1'), tk2 = $('#tk2');
  if (tk1 && tk2) fetch('/api/skills').then(r => r.json()).then(({ data }) => {
    const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const pick = ['Electrician', 'Software developer', 'Plumber', 'Registered nurse', 'Graphic designer', 'Civil engineer', 'Bookkeeper', 'Solar PV installer', 'Data scientist', 'Chef', 'Carpenter', 'Videographer', 'Attorney', 'Farm manager', 'Delivery driver', 'Tiler', 'Actuary', 'Caregiver for the elderly'];
    const all = Object.values(data.general).flat();
    const big = pick.filter(n => all.includes(n));
    const want = ['Software Developer', 'Data Scientist', 'Civil Engineer', 'Actuary', 'ICT Security Specialist', 'Chemical Engineer', 'Quantity Surveyor', 'Architect', 'Millwright', 'Air Traffic Controller', 'Veterinarian', 'Mechatronics Technician', 'External Auditor', 'Metallurgist', 'Electronics Engineer', 'Lift Mechanic', 'Geologist', 'Economist', 'Network Analyst', 'Industrial Pharmacist', 'Energy Engineer', 'Mining Engineer'];
    const names = data.critical.map(c => c.name), crit = want.filter(n => names.includes(n));
    const row = (items, html) => { const one = items.map(html).join(''); return one + `<span aria-hidden="true" style="display:inline-flex">${one.replace(/<a /g, '<a tabindex="-1" ')}</span>`; };
    tk1.innerHTML = row(big, (n, i) => `<a class="tk-item${i % 3 === 1 ? ' outline' : ''}" href="#jobs" data-task="${esc(n)}">${esc(n)}</a><span class="tk-sep" aria-hidden="true">✦</span>`);
    tk2.innerHTML = row(crit, n => `<a class="tk-item" href="/skills.html#critical">${esc(n)} <i>Critical skill</i></a>`);
    requestAnimationFrame(() => { tk1.style.setProperty('--tk-dur', Math.round(tk1.scrollWidth / 2 / 55) + 's'); tk2.style.setProperty('--tk-dur', Math.round(tk2.scrollWidth / 2 / 40) + 's'); });
  }).catch(() => $('.ticker')?.remove());

  /* ---------- one rAF loop for everything tied to scrolling ---------- */
  const hero = $('.hero'), photo = $('.hero-photo'), pulse = $('.theatre .pulse'), biz = $('.biz-img');
  const bands = $$('.biz, .intl-band'), paths = $$('.path ol');
  // measure the line through each list of steps (circle centre of the first step to the last)
  const measure = () => paths.forEach(ol => {
    const li = $$('li', ol); if (li.length < 2) return;
    const c = (el) => el.offsetTop + 30;
    ol._top = c(li[0]); ol._len = c(li[li.length - 1]) - ol._top; ol._li = li;
    ol.style.setProperty('--l-top', ol._top + 'px'); ol.style.setProperty('--l-len', ol._len + 'px');
  });
  measure(); addEventListener('load', measure); addEventListener('resize', measure, { passive: true });
  let ticking = false;
  const onScroll = () => {
    ticking = false;
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    if (prog) prog.style.setProperty('--p', max > 0 ? Math.min(1, y / max).toFixed(4) : 0);
    if (reduce) return;
    for (const ol of paths) {
      if (!ol._len) continue;
      const r = ol.getBoundingClientRect(); if (r.bottom < -200 || r.top > innerHeight + 200) continue;
      const p = Math.max(0, Math.min(1, (innerHeight * .62 - (r.top + ol._top)) / ol._len));
      ol.style.setProperty('--prog', p.toFixed(3));
      ol._li.forEach(li => li.classList.toggle('lit', p >= (li.offsetTop + 30 - ol._top) / ol._len - .02));
    }
    if (!wide()) return;
    if (hero && y < innerHeight * 1.2) {
      photo?.style.setProperty('--py', (y * -0.07).toFixed(1));
      pulse?.style.setProperty('--py2', (y * -0.14).toFixed(1));
    }
    // dark bands open out as they arrive
    for (const band of bands) {
      const r = band.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) band.style.setProperty('--sp', Math.max(0, Math.min(1, (innerHeight - r.top) / (innerHeight * .55))).toFixed(3));
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
  const fire = () => { if (document.hidden) return; try { spark.beginElement(); $('.bridge .spark animate')?.beginElement(); } catch {} };
  if (spark) { const hd = document.documentElement.classList.contains('intro') ? 1150 : 0; setTimeout(() => { fire(); setInterval(fire, 11000); }, 2600 + hd); }

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

  /* ---------- numbers roll into place like an odometer ---------- */
  const odometer = (el) => {
    if (el.dataset.counted) return; el.dataset.counted = '1';
    const raw = el.textContent.trim(); if (!/\d/.test(raw)) return;
    el.setAttribute('aria-label', raw);
    let di = 0;
    el.innerHTML = '<span aria-hidden="true">' + [...raw].map(ch => {
      if (!/\d/.test(ch)) return ch === ' ' || ch === '\u00a0' ? '&nbsp;' : ch.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const digits = Array.from({ length: 20 }, (_, k) => `<span>${k % 10}</span>`).join('');
      return `<span class="odo"><span class="odo-col" data-n="${ch}" style="--od:${(di++) * .09}s">${digits}</span></span>`;
    }).join('') + '</span>';
    requestAnimationFrame(() => requestAnimationFrame(() => $$('.odo-col', el).forEach(c => { c.style.transform = `translate3d(0,${-((10 + +c.dataset.n) / 20) * 100}%,0)`; })));
  };
  const cio = new IntersectionObserver((es) => es.forEach(e => { if (e.isIntersecting) { $$('b', e.target).forEach(odometer); } }), { threshold: 0.4 });
  const facts = $('#facts');
  if (facts) { cio.observe(facts); new MutationObserver(() => { if (facts.getBoundingClientRect().top < innerHeight) $$('b', facts).forEach(odometer); }).observe(facts, { childList: true }); }

  if (!fine) return; // everything below follows the mouse

  /* ---------- hero: floating chips drift with the pointer ---------- */
  if (hero) hero.addEventListener('pointermove', (e) => {
    if (!wide()) return;
    const r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    $$('.chip-float', hero).forEach((c, i) => { c.style.setProperty('--mx', (x * (i ? -1 : 1)).toFixed(3)); c.style.setProperty('--my', (y * (i ? -1 : 1)).toFixed(3)); });
  });

  /* ---------- hero spotlight + 3D photo with glare ---------- */
  if (hero) {
    const glare = document.createElement('span'); glare.className = 'glare'; photo?.append(glare);
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty('--sx', (e.clientX - r.left) + 'px'); hero.style.setProperty('--sy', (e.clientY - r.top) + 'px'); hero.classList.add('lit');
      if (!photo || !wide()) return;
      const pr = photo.getBoundingClientRect();
      const inside = e.clientX > pr.left - 40 && e.clientX < pr.right + 40 && e.clientY > pr.top - 40 && e.clientY < pr.bottom + 40;
      if (!inside) { photo.classList.remove('tilting'); photo.style.setProperty('--prx', 0); photo.style.setProperty('--pry', 0); return; }
      const x = (e.clientX - pr.left) / pr.width, y = (e.clientY - pr.top) / pr.height;
      photo.classList.add('tilting');
      photo.style.setProperty('--pry', ((x - .5) * 9).toFixed(2)); photo.style.setProperty('--prx', ((.5 - y) * 7).toFixed(2));
      photo.style.setProperty('--gx', (x * 100).toFixed(1) + '%'); photo.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
    });
    hero.addEventListener('pointerleave', () => { hero.classList.remove('lit'); photo?.classList.remove('tilting'); photo?.style.setProperty('--prx', 0); photo?.style.setProperty('--pry', 0); });
  }

  /* ---------- contextual cursor: "View" over clickable cards ---------- */
  const cur = document.createElement('div'); cur.className = 'cur'; cur.setAttribute('aria-hidden', 'true'); document.body.append(cur);
  const curMap = [['.job', 'View job'], ['.person', 'View'], ['.tk-big .tk-item', 'Search'], ['.prov', 'Explore']];
  let cx = -200, cy = -200, tx = -200, ty = -200, curOn = false, raf = 0;
  const glide = () => { cx += (tx - cx) * .2; cy += (ty - cy) * .2; cur.style.setProperty('--cx', cx.toFixed(1) + 'px'); cur.style.setProperty('--cy', cy.toFixed(1) + 'px');
    raf = (Math.abs(tx - cx) > .3 || Math.abs(ty - cy) > .3) ? requestAnimationFrame(glide) : 0; };
  document.addEventListener('pointermove', (e) => {
    tx = e.clientX; ty = e.clientY;
    const hit = curMap.find(([sel]) => e.target.closest?.(sel));
    const overControl = e.target.closest?.('button:not(.prov), input, select, textarea, .btn');
    const on = !!hit && !overControl;
    if (on !== curOn) { curOn = on; cur.classList.toggle('on', on); document.querySelectorAll('.cur-hide').forEach(x => x.classList.remove('cur-hide')); if (!on) { cx = tx; cy = ty; } }
    if (on) { cur.textContent = hit[1]; cur.classList.toggle('light', hit[0] === '.prov'); e.target.closest(hit[0]).classList.add('cur-hide'); }
    if (!raf) raf = requestAnimationFrame(glide);
  }, { passive: true });
  document.addEventListener('scroll', () => { if (curOn) { curOn = false; cur.classList.remove('on'); } }, { passive: true });

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
  let curTilt = null;
  const reset = (el) => { el.classList.remove('tilting'); el.style.setProperty('--rx', 0); el.style.setProperty('--ry', 0); };
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.(tiltSel);
    if (curTilt && curTilt !== el) { reset(curTilt); curTilt = null; }
    if (!el) return;
    curTilt = el; el.classList.add('tilt', 'tilting');
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const max = el.matches('.cta2 a') ? 3 : 5;
    el.style.setProperty('--ry', ((x - .5) * max * 2).toFixed(2));
    el.style.setProperty('--rx', ((.5 - y) * max * 2).toFixed(2));
    el.style.setProperty('--gx', (x * 100).toFixed(1) + '%'); el.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (curTilt) { reset(curTilt); curTilt = null; } });

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
