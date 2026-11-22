const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rand=n=>'R'+Math.round(n||0).toLocaleString('en-ZA');
const num=n=>Number(n||0).toLocaleString('en-ZA');
const initials=n=>String(n||'?').split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
const ago=s=>{if(!s)return'';const d=(Date.now()-new Date(s.replace(' ','T')+'Z'))/1000;if(d<60)return'just now';if(d<3600)return Math.floor(d/60)+' min ago';if(d<86400)return Math.floor(d/3600)+' h ago';if(d<86400*30)return Math.floor(d/86400)+' d ago';return new Date(s.replace(' ','T')+'Z').toLocaleDateString('en-ZA',{day:'numeric',month:'short'})};
const unit=u=>({hour:'per hour',day:'per day',month:'per month',project:'fixed price'})[u]||'';
$('#yr').textContent=new Date().getFullYear();
async function get(p){const r=await fetch('/api'+p);if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'Could not load');return r.json()}
function toast(m,err){const t=document.createElement('div');t.className='toast'+(err?' err':'');t.innerHTML=`<span>${esc(m)}</span><button class="x" aria-label="Dismiss">×</button>`;t.querySelector('.x').onclick=()=>t.remove();$('#toasts').append(t);setTimeout(()=>t.remove(),5000)}
const failBox=(msg,retry)=>{const d=document.createElement('div');d.className='err-box';d.innerHTML=`<span>${esc(msg)}</span><button class="btn sm ghost">Try again</button>`;d.querySelector('button').onclick=retry;return d};

/* header */
addEventListener('scroll',()=>$('#hd').classList.toggle('stuck',scrollY>8),{passive:true});
$('#menu').onclick=()=>{const o=$('#nav').classList.toggle('open');$('#menu').setAttribute('aria-expanded',o)};
$('#nav').onclick=e=>{if(e.target.closest('a'))$('#nav').classList.remove('open')};
let signedIn=false;try{signedIn=!!localStorage.getItem('tb_token')||!!localStorage.getItem('siira_token')}catch{}
if(signedIn)$('#acts').innerHTML='<a class="btn sm" href="/app.html">Open dashboard</a>';

/* state */
const S={meta:null,mode:'jobs',q:'',province:'',category:'',type:'',page:1,tsort:'rating'};

/* icons per category (by keyword so new categories still get one) */
const ICONS={trade:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',constr:'<path d="M2 20h20M5 20V9l7-5 7 5v11M9 20v-6h6v6"/>',clean:'<path d="M3 21h18M6 21l1-9h10l1 9M9 12V4a3 3 0 0 1 6 0v8"/>',creat:'<path d="M12 19l7-7 3 3-7 7zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18zM2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>',trans:'<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',busin:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>'};
const TASKS={trade:['Electrician','Plumber','Geyser repair','Solar installer','Handyman','Aircon service'],constr:['Builder','Painter','Tiler','Roofing','Paving','Site supervisor'],clean:['Home cleaner','Office cleaning','Carpet cleaning','Elder care','Gardener','Laundry'],creat:['Logo design','Website','Photography','Video editing','Social media','Copywriting'],trans:['Delivery driver','Furniture removal','Courier','Bakkie hire','Chauffeur','Truck driver'],busin:['Bookkeeper','Payroll','Admin assistant','VAT returns','Data capture','Receptionist']};
const tasksFor=name=>TASKS[Object.keys(TASKS).find(k=>name.toLowerCase().includes(k))]||[];
const icon=name=>{const k=Object.keys(ICONS).find(k=>name.toLowerCase().includes(k));return`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]||ICONS.busin}</svg>`};

/* meta drives every list on the page */
async function loadMeta(){
  S.meta=await get('/meta');
  $('#sprov').innerHTML='<option value="">All provinces</option>'+S.meta.provinces.map(p=>`<option>${esc(p)}</option>`).join('');
  const PHOTO=n=>({trade:'cat-trades',constr:'cat-construction',clean:'cat-cleaning',creat:'cat-creative',trans:'cat-transport',busin:'cat-business'}[Object.keys(TASKS).find(k=>n.toLowerCase().includes(k))]);
  $('#morecats').innerHTML=S.meta.categories.filter(c=>!PHOTO(c.name)).map(c=>`<button class="chip" data-cat="${esc(c.name)}">${esc(c.name)}${c.open_jobs?` <small>${c.open_jobs}</small>`:''}</button>`).join('');
  $('#cats').innerHTML=S.meta.categories.filter(c=>PHOTO(c.name)).map(c=>{const t=tasksFor(c.name);const k=Object.keys(TASKS).find(k=>c.name.toLowerCase().includes(k));const photo={trade:'cat-trades',constr:'cat-construction',clean:'cat-cleaning',creat:'cat-creative',trans:'cat-transport',busin:'cat-business'}[k];return`<div class="cat">${photo?`<img class="cat-img" src="/assets/photos/${photo}-800.jpg" alt="" loading="lazy">`:''}<div class="top"><span class="ic">${icon(c.name)}</span><div><h3>${esc(c.name)}</h3><span class="count">${c.open_jobs?`${c.open_jobs} open job${c.open_jobs>1?'s':''}`:'Be the first to post'}</span></div></div>
    <div class="tasks">${t.map(x=>`<button data-task="${esc(x)}">${esc(x)}</button>`).join('')}</div><button class="all" data-cat="${esc(c.name)}">See ${esc(c.name.toLowerCase())} jobs</button></div>`}).join('');
  $('#popular').innerHTML='Popular:'+S.meta.categories.slice().sort((a,b)=>b.open_jobs-a.open_jobs).slice(0,4).map(c=>`<button class="chip" data-cat="${esc(c.name)}">${esc(c.name)}</button>`).join('');
  $('#types').innerHTML=[['','All jobs'],...S.meta.types.map(t=>[t,t])].map(([v,l])=>`<button class="chip" data-type="${esc(v)}" aria-pressed="${v===S.type}">${esc(l)}</button>`).join('');
  $('#tsort').innerHTML=[['rating','Top rated'],['jobs','Most jobs'],['rate_low','Lowest rate']].map(([v,l])=>`<button class="chip" data-tsort="${v}" aria-pressed="${v===S.tsort}">${l}</button>`).join('');
  calc();
}

/* live pulse */
let seen=new Set(),firstPulse=true;
async function loadPulse(){
  try{const {data}=await get('/pulse');
    if(!data.length){$('#pulse').innerHTML=`<li class="start"><span class="ico job" aria-hidden="true">NEW</span><div><b>TalentBridge is open for business</b><small>New jobs and bids will show here the moment they’re posted.</small></div></li>
      <li class="start-cta"><a class="btn sm" href="/app.html#register">Post the first job</a><a class="btn sm ghost-light" href="/app.html#register">Join as a professional</a></li>`;return}
    $('#pulse').innerHTML=data.map(p=>{const key=p.kind+(p.id||p.job_id)+p.at,isNew=!firstPulse&&!seen.has(key);seen.add(key);
      return p.kind==='job'
        ?`<li class="${isNew?'new':''}"><span class="ico job" aria-hidden="true">JOB</span><div><a href="#job-${p.id}" data-job="${p.id}">${esc(p.title)}</a> posted in ${esc(p.city)}<small>${p.bids?`${p.bids} bid${p.bids>1?'s':''}${p.avg_bid?`, avg bid ${rand(p.avg_bid)}`:''}`:'Be the first to bid'} · ${ago(p.at)}</small></div></li>`
        :`<li class="${isNew?'new':''}"><span class="av sm" style="--c:${esc(p.avatar_color||'#6a4bd8')}" aria-hidden="true">${initials(p.name)}</span><div>${esc(p.name)} bid on <a href="#job-${p.job_id}" data-job="${p.job_id}">${esc(p.title)}</a><small>${esc(p.city)} · ${ago(p.at)}</small></div></li>`}).join('');
    firstPulse=false;
  }catch{ if(firstPulse)$('#pulse').innerHTML='<li><span>Live activity is unavailable right now.</span></li>'}
}

async function loadFacts(){
  try{const s=await get('/stats');
    const fresh=(s.professionals+s.open_jobs+s.jobs_completed)<3;
    const pct=S.meta?.commission_pct??10;
    const f=fresh?[['Free','to post a job or bid'],[pct+'%','fee, only when you’re paid'],['9','provinces covered'],['Escrow','on every contract'],['Live','chat, bids and offers']]
      :[[num(s.professionals),'professionals'],[num(s.open_jobs),'open jobs'],[s.avg_rating?s.avg_rating.toFixed(1)+' / 5':'New','average rating'],[num(s.jobs_completed),'jobs completed'],[num(s.bids_this_week),'bids this week']];
    if(s.avg_rating){$('#rateVal').textContent=s.avg_rating.toFixed(1)+' out of 5';$('#rateChip').hidden=false}
    $('#facts').innerHTML=f.map(([v,l])=>`<div><b>${v}</b>${l}</div>`).join('');
  }catch{$('#facts').hidden=true}
}

/* jobs */
const bitsAny=()=>['q','province','category','type'].some(k=>S[k]);
const jobCard=j=>`<article class="job" data-job="${j.id}" tabindex="0" aria-label="${esc(j.title)}">
  <div><h3>${esc(j.title)}${j.featured?'<span class="feat">Featured</span>':''}${j.open_to_international?'<span class="feat visa">Visa sponsorship</span>':''}${j.remote?'<span class="feat visa">Remote</span>':''}</h3><div class="meta"><span>${esc(j.location)}</span><span>${esc(j.type)}</span><span>${esc(j.category)}</span><span>${ago(j.created_at)}</span></div></div>
  <div class="pay"><b>${esc(j.pay_label)}</b><span>${j.bids?`${j.bids} bid${j.bids>1?'s':''}${j.avg_bid?` · avg bid ${rand(j.avg_bid)}`:''}`:'No bids yet'}</span></div>
  <p class="desc">${esc(j.description)}</p></article>`;
async function loadJobs(append){
  const list=$('#joblist');
  if(!append){S.page=1;list.innerHTML=Array(3).fill('<div class="skel" style="height:118px;border-radius:18px"></div>').join('')}
  const p=new URLSearchParams({page:S.page,limit:8});for(const k of['q','province','category','type'])if(S[k])p.set(k,S[k]);
  try{const j=await get('/jobs?'+p);
    const html=j.data.map(jobCard).join('');
    if(append)list.insertAdjacentHTML('beforeend',html);else list.innerHTML=html||(!bitsAny()?`<div class="empty panel invite"><h3>Be the first to post a job</h3><p>Describe what you need and verified professionals will send you their price and timeline.</p><a class="btn" href="/app.html#register">Post a job for free</a></div>`:'')||`<div class="empty panel"><h3>No open jobs match</h3><p>Try another search, or <a href="/app.html#register">post this job yourself</a>.</p></div>`;
    $('#jobmore').hidden=j.meta.page>=j.meta.pages;
    const bits=[S.q&&`“${S.q}”`,S.category,S.type,S.province].filter(Boolean);
    $('#jobs-sub').textContent=bits.length?`${j.meta.total} job${j.meta.total===1?'':'s'} for ${bits.join(', ')}.`:'Place a bid with your price and timeline. Clients compare bids, chat, then hire.';
  }catch(e){list.innerHTML='';list.append(failBox(e.message,()=>loadJobs()))}
}
$('#jobmore').onclick=()=>{S.page++;loadJobs(true)};

/* talent */
const personCard=t=>`<button class="person" data-talent="${t.id}">
  <div class="top"><span class="av" style="--c:${esc(t.avatar_color||'#6a4bd8')}">${initials(t.name)}</span><div><h3>${esc(t.name)}</h3><span class="mut">${esc(t.headline||'Professional')}</span></div></div>
  <div class="skills">${t.skills.slice(0,4).map(s=>`<span class="tag">${esc(s)}</span>`).join('')}</div>
  <div class="foot"><span><span class="stars">★ ${t.rating?t.rating.toFixed(1):'New'}</span> · ${t.jobs_done} jobs</span><span>${t.hourly_rate?`<b>R${num(t.hourly_rate)}</b>/hr`:''}</span></div>
  ${t.verified?'<span class="verified">✓ ID verified</span>':''}</button>`;
async function loadTalent(){
  const box=$('#people');box.innerHTML=Array(4).fill('<div class="skel" style="height:190px;border-radius:18px"></div>').join('');
  const p=new URLSearchParams({limit:8,sort:S.tsort});if(S.mode==='talent'&&S.q)p.set('q',S.q);if(S.province)p.set('province',S.province);
  try{const j=await get('/talent?'+p);box.innerHTML=j.data.map(personCard).join('')||(!(S.mode==='talent'&&S.q)&&!S.province?'<div class="empty panel invite"><h3>Be one of our first professionals</h3><p>Create a free profile, add your skills and get alerts when matching jobs are posted near you.</p><a class="btn" href="/app.html#register">Create your profile</a></div>':'')||'<div class="empty panel"><h3>No professionals match yet</h3><p>Try a broader search.</p></div>'}
  catch(e){box.innerHTML='';box.append(failBox(e.message,loadTalent))}
}

/* drawers */
function drawer(html){const d=document.createElement('div');d.className='drawer';d.innerHTML=`<div class="in dr" role="dialog" aria-modal="true"><button class="dr-close" aria-label="Close">×</button>${html}</div>`;
  const close=()=>{d.remove();document.removeEventListener('keydown',k)};const k=e=>{if(e.key==='Escape')close()};
  d.onclick=e=>{if(e.target===d||e.target.closest('.dr-close'))close()};document.addEventListener('keydown',k);document.body.append(d);d.querySelector('.dr-close').focus();return d}
async function openJob(id){
  const d=drawer('<div class="skel" style="height:300px"></div>');
  try{const {data:j}=await get('/jobs/'+id);const c=j.client||{};
    d.querySelector('.in').innerHTML=`<button class="dr-close" aria-label="Close">×</button><span class="st ${j.status==='open'?'ok':''}">${j.status==='open'?'Open for bids':'Closed'}</span><h2>${esc(j.title)}</h2>
    <p class="mut">${esc(j.location)} · ${esc(j.type)} · ${esc(j.category)} · posted ${ago(j.created_at)}</p>
    <div class="kv"><div>Budget<b>${esc(j.pay_label)}</b></div><div>Bids<b>${j.bids}${j.avg_bid?` · avg ${rand(j.avg_bid)}`:''}</b></div><div>Client<b>${esc(c.name||'Client')}</b></div><div>Client history<b>${c.jobs_posted||0} posted · ${c.hires||0} paid</b></div></div>
    <p class="body">${esc(j.description)}</p>
    ${j.status==='open'?`<a class="btn wide" href="/app.html#job/${j.id}">Place a bid</a><p class="hint" style="text-align:center;margin-top:10px">Free to bid. You’ll need a TalentBridge account.</p>`:''}`;
  }catch(e){d.querySelector('.in').innerHTML='<button class="dr-close" aria-label="Close">×</button>';d.querySelector('.in').append(failBox(e.message,()=>{d.remove();openJob(id)}))}
}
async function openTalent(id){
  const d=drawer('<div class="skel" style="height:300px"></div>');
  try{const {data:t}=await get('/talent/'+id);
    d.querySelector('.in').innerHTML=`<button class="dr-close" aria-label="Close">×</button><div style="display:flex;gap:16px;align-items:center;margin-top:8px"><span class="av lg" style="--c:${esc(t.avatar_color||'#6a4bd8')}">${initials(t.name)}</span><div><h2 style="margin:0">${esc(t.name)}</h2><span class="mut">${esc(t.headline||'')}</span>${t.verified?'<br><span class="verified">✓ ID verified</span>':''}</div></div>
    <div class="kv"><div>Rating<b class="stars">★ ${t.rating?t.rating.toFixed(1):'New'}</b></div><div>Jobs done<b>${t.jobs_done}</b></div><div>Rate<b>${t.hourly_rate?'R'+num(t.hourly_rate)+' per hour':'Ask for a quote'}</b></div><div>Location<b>${esc([t.city,t.province].filter(Boolean).join(', ')||'South Africa')}</b></div></div>
    ${t.bio?`<p class="body">${esc(t.bio)}</p>`:''}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 20px">${t.skills.map(s=>`<span class="tag">${esc(s)}</span>`).join('')}</div>
    ${t.languages?`<p><b>Languages:</b> ${esc(t.languages)}</p>`:''}
    ${t.checks?.identity?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px"><span class="tag">✓ Identity checked</span>${t.checks.address?'<span class="tag">✓ Address checked</span>':''}${t.checks.has_cv?'<span class="tag">✓ CV on file</span>':''}</div>`:''}
    ${t.qualifications?.length?`<h3 style="font-size:22px;margin:22px 0 8px">Qualifications</h3>${t.qualifications.map(q=>`<div class="review"><b>${esc(q.qualification)}</b><br><span class="mut">${esc(q.institution)}${q.year?' · '+q.year:''}</span><br><small>${q.verified?'✓ Confirmed with the institution':'Being confirmed with the institution'}</small></div>`).join('')}`:''}
    ${t.portfolio.length?`<h3 style="font-size:22px;margin:22px 0 8px">Past work</h3>${t.portfolio.map(p=>`<div class="review"><b>${p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${esc(p.title)}</a>`:esc(p.title)}</b><br><span class="mut">${esc(p.description)}</span></div>`).join('')}`:''}
    <h3 style="font-size:22px;margin:22px 0 8px">Reviews</h3>${t.reviews.length?t.reviews.map(r=>`<div class="review"><span class="stars">${'★'.repeat(r.rating)}</span> <b>${esc(r.job_title)}</b><p style="margin:4px 0">${esc(r.comment||'No comment left.')}</p><small class="mut">${esc(r.client_name)} · ${ago(r.created_at)}</small></div>`).join(''):'<p class="mut">No reviews yet.</p>'}
    <a class="btn wide" style="margin-top:20px" href="/app.html#talent/${t.id}">Message or hire ${esc(t.name.split(' ')[0])}</a>
    <details style="margin-top:16px"><summary class="link" style="cursor:pointer">No account? Send an enquiry instead</summary>
      <form id="hire" style="margin-top:14px"><label>Your name<input name="from_name" required minlength="2"></label><label>Email<input name="from_email" type="email" required></label><label>What do you need done?<textarea name="message" required minlength="10"></textarea></label><button class="btn soft">Send enquiry</button></form></details>`;
    d.querySelector('#hire').onsubmit=async e=>{e.preventDefault();const r=await fetch(`/api/talent/${t.id}/hire-request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});
      if(r.ok){toast('Enquiry sent. We’ll put you in touch.');d.remove()}else toast((await r.json()).error||'Could not send',true)};
  }catch(e){d.querySelector('.in').innerHTML='<button class="dr-close" aria-label="Close">×</button>';d.querySelector('.in').append(failBox(e.message,()=>{d.remove();openTalent(id)}))}
}

/* fee calculator uses live commission and VAT */
function calc(){if(!S.meta)return;const a=Math.max(0,+$('#calc-amt').value||0),fee=a*S.meta.commission_pct/100,vat=fee*S.meta.vat_pct/100;
  $('#calc-out').innerHTML=`<dt>Client pays into escrow</dt><dd>${rand(a)}</dd><dt>Service fee (${S.meta.commission_pct}%)</dt><dd>−${rand(fee)}</dd><dt>VAT on the fee (${S.meta.vat_pct}%)</dt><dd>−${rand(vat)}</dd><dt class="tot">Professional receives</dt><dd class="tot" style="color:var(--moss)">${rand(a-fee-vat)}</dd>`}
$('#calc-amt').oninput=calc;

/* interactions */
document.addEventListener('click',e=>{
  const j=e.target.closest('[data-job]');if(j){e.preventDefault();return openJob(j.dataset.job)}
  const t=e.target.closest('[data-talent]');if(t)return openTalent(t.dataset.talent);
  const tk=e.target.closest('[data-task]');if(tk){S.q=tk.dataset.task;S.category='';S.type='';S.mode='jobs';$('#q').value=S.q;loadJobs();$('#jobs').scrollIntoView({behavior:'smooth'});return}
  const pv=e.target.closest('[data-prov]');if(pv){S.province=pv.dataset.prov;$('#sprov').value=S.province;S.q='';loadJobs();loadTalent();$('#jobs').scrollIntoView({behavior:'smooth'});return}
  const c=e.target.closest('[data-cat]');if(c){S.category=S.category===c.dataset.cat?'':c.dataset.cat;S.q='';S.mode='jobs';loadJobs();$('#jobs').scrollIntoView({behavior:'smooth'});return}
  const ty=e.target.closest('[data-type]');if(ty){S.type=ty.dataset.type;document.querySelectorAll('[data-type]').forEach(b=>b.setAttribute('aria-pressed',b===ty));return loadJobs()}
  const ts=e.target.closest('[data-tsort]');if(ts){S.tsort=ts.dataset.tsort;document.querySelectorAll('[data-tsort]').forEach(b=>b.setAttribute('aria-pressed',b===ts));return loadTalent()}
  const m=e.target.closest('[data-mode]');if(m){S.mode=m.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',b===m));$('#q').placeholder=S.mode==='jobs'?'Try “plumber” or “React”':'Try “electrician” or “bookkeeper”'}
});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('.job'))openJob(e.target.dataset.job)});
$('#search').onsubmit=e=>{e.preventDefault();S.q=$('#q').value.trim();S.province=$('#sprov').value;
  if(S.mode==='jobs'){loadJobs();$('#jobs').scrollIntoView({behavior:'smooth'})}else{loadTalent();$('#talent').scrollIntoView({behavior:'smooth'})}};
$('#cform').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;
  try{const r=await fetch('/api/contact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.details?.[0]?.message||j.error||'Could not send');e.target.reset();$('#cmsg').textContent='Thanks. We’ll reply by email.'}
  catch(err){toast(err.message,true)}finally{b.disabled=false}};

/* deep links like /#job-12 */
const deep=()=>{const m=location.hash.match(/^#(job|talent)-(\d+)$/);if(m)(m[1]==='job'?openJob:openTalent)(m[2])};
addEventListener('hashchange',deep);

loadMeta().catch(()=>{$('#cats').innerHTML='';$('#cats').append(failBox('Could not load categories.',loadMeta))});
async function loadReviews(){try{const {data}=await get('/reviews');if(!data.length)return;$('#reviews').hidden=false;
  $('#quotes').innerHTML=data.map(r=>`<figure class="quote"><span class="stars" aria-label="${r.rating} out of 5">${'★'.repeat(r.rating)}</span><blockquote>“${esc(r.comment)}”</blockquote><figcaption><span class="av" style="--c:${esc(r.avatar_color||'#6a4bd8')}">${initials(r.talent_name)}</span><span><b>${esc(r.client_name)} hired ${esc(r.talent_name)}</b>${esc(r.job_title)}${r.city?', '+esc(r.city):''} · ${ago(r.created_at)}</span></figcaption></figure>`).join('')}catch{}}
async function loadProvinces(){try{const {data}=await get('/provinces');
  if(!data.some(p=>p.open_jobs||p.professionals)){$('#provs').innerHTML=data.map(p=>`<button class="prov" data-prov="${esc(p.name)}"><span><b>${esc(p.name)}</b><small>Hire or work here</small></span><span class="go-arrow" aria-hidden="true">›</span></button>`).join('');return}
  $('#provs').innerHTML=data.map(p=>`<button class="prov" data-prov="${esc(p.name)}"><span><b>${esc(p.name)}</b><small>${p.professionals} professional${p.professionals===1?'':'s'}</small></span><span class="n" aria-label="${p.open_jobs} open jobs">${p.open_jobs}<small style="display:block;font:600 12px var(--sans);color:var(--mut);text-align:right">open jobs</small></span></button>`).join('')}catch{$('#areas').hidden=true}}
{const q0=new URLSearchParams(location.search).get('q');if(q0){S.q=q0.slice(0,80);const qi=$('#q');if(qi)qi.value=S.q;setTimeout(()=>$('#jobs').scrollIntoView(),300)}}
loadPulse();loadFacts();loadJobs();loadTalent();loadReviews();loadProvinces();deep();
setInterval(()=>{if(!document.hidden)loadPulse()},20000);

/* hero slideshow */
(function(){
  const box=document.getElementById('heroShow');if(!box)return;
  const slides=[...box.querySelectorAll('.slide')],bars=[...box.querySelectorAll('.bar')];
  const capT=document.getElementById('capT'),capC=document.getElementById('capC'),cap=box.querySelector('.cap');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;const DUR=6000;
  let i=0,timer=null,left=DUR,started=0,paused=false;
  const load=n=>{const im=slides[n];if(im&&im.dataset.src&&!im.src){im.src=im.dataset.src}};
  function show(n){
    load(n);load((n+1)%slides.length);
    const go=()=>{slides.forEach((s,k)=>s.classList.toggle('on',k===n));
      bars.forEach((b,k)=>{b.classList.toggle('done',k<n);b.classList.remove('on');b.setAttribute('aria-current',k===n)});
      void bars[n].offsetWidth;bars[n].classList.add('on');
      capT.textContent=slides[n].dataset.cap;capC.textContent=slides[n].dataset.city;cap.classList.remove('swap');void cap.offsetWidth;cap.classList.add('swap');
      i=n;left=DUR;schedule()};
    const im=slides[n];if(im.complete&&im.naturalWidth)go();else{im.addEventListener('load',go,{once:true});im.addEventListener('error',()=>{i=n;next()},{once:true})}
  }
  function schedule(){clearTimeout(timer);if(paused||reduce)return;started=Date.now();timer=setTimeout(next,left)}
  function next(){show((i+1)%slides.length)}
  function pause(){if(paused)return;paused=true;clearTimeout(timer);left-=Date.now()-started;box.classList.add('paused')}
  function resume(){if(!paused)return;paused=false;box.classList.remove('paused');schedule()}
  box.style.setProperty('--dur',DUR+'ms');
  bars.forEach((b,k)=>b.addEventListener('click',()=>{paused=false;box.classList.remove('paused');show(k)}));
  box.addEventListener('mouseenter',pause);box.addEventListener('mouseleave',resume);
  document.addEventListener('visibilitychange',()=>document.hidden?pause():resume());
  if(reduce)box.classList.add('paused');
  show(0);
})();
