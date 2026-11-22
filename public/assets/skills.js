(()=>{const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let D=null,view='all';
const NQF={3:'NQF 3 (Intermediate Certificate)',4:'NQF 4 (National Certificate)',6:'NQF 6 (Diploma)',7:'NQF 7 (Bachelor’s or Advanced Diploma)',8:'NQF 8 (Honours, Postgraduate Diploma or 4-year Bachelor’s)',9:'NQF 9 (Master’s)',10:'NQF 10 (Doctorate)'};
function render(){const q=$('#skq').value.trim().toLowerCase();const m=s=>!q||s.toLowerCase().includes(q);let html='',n=0;
  const crit=D.critical.filter(c=>m(c.name)||m(c.field)||c.ofo.includes(q));
  if(view==='critical'){const fields=[...new Set(crit.map(c=>c.field))];
    html=fields.map(f=>{const rows=crit.filter(c=>c.field===f);n+=rows.length;return`<section class="sk-grp"><h2>${esc(f)} <small>${rows.length}</small></h2><div class="tw"><table><thead><tr><th>Occupation</th><th>OFO code</th><th>Minimum qualification</th><th>Registration</th></tr></thead><tbody>${rows.map(c=>`<tr><td><b>${esc(c.name)}</b></td><td class="mono">${esc(c.ofo)}</td><td>${esc(NQF[c.nqf]||'NQF '+c.nqf)}</td><td>${esc(c.registration)}</td></tr>`).join('')}</tbody></table></div></section>`}).join('');
  }else{const cs=new Set(D.critical.map(c=>c.name.toLowerCase()));
    html=Object.entries(D.general).map(([cat,names])=>{const rows=names.filter(m);n+=rows.length;if(!rows.length)return'';return`<section class="sk-grp"><h2>${esc(cat)} <small>${rows.length}</small></h2><div class="sk-chips">${rows.map(x=>`<a class="sk-chip" href="/?q=${encodeURIComponent(x)}#jobs">${esc(x)}</a>`).join('')}</div></section>`}).join('');
    if(crit.length){n+=crit.length;html+=`<section class="sk-grp"><h2>Critical skills <small>${crit.length}</small></h2><div class="sk-chips">${crit.map(c=>`<span class="sk-chip crit" title="${esc(c.ofo)} · ${esc(NQF[c.nqf]||'')}">${esc(c.name)}<i>Critical skill</i></span>`).join('')}</div></section>`}}
  $('#skl').innerHTML=html||'<p class="mut">No skills match your search.</p>';$('#skn').textContent=`${n} ${view==='critical'?'critical skills occupations':'skills'}${q?' match “'+$('#skq').value.trim()+'”':''}`}
document.querySelectorAll('.sk-tabs .chip').forEach(b=>b.onclick=()=>{view=b.dataset.v;document.querySelectorAll('.sk-tabs .chip').forEach(x=>x.setAttribute('aria-pressed',x===b));render()});
$('#skq').oninput=render;
if(location.hash==='#critical'){view='critical';document.querySelectorAll('.sk-tabs .chip').forEach(x=>x.setAttribute('aria-pressed',x.dataset.v==='critical'))}
fetch('/api/skills').then(r=>r.json()).then(j=>{D=j.data;render()}).catch(()=>{$('#skl').innerHTML='<p class="mut">Couldn’t load the skills. Refresh the page to try again.</p>'});
})();