(() => {
  const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
  let timer=null,progressTimer=null;
  function style(){if($('#announcementStyle'))return;const s=document.createElement('style');s.id='announcementStyle';s.textContent=`
    .announcement-page-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:16px}.announcement-editor textarea{width:100%;min-height:150px;resize:vertical}.announcement-duration-row{display:grid;grid-template-columns:1fr 120px;gap:12px;align-items:end}.announcement-preview-box{min-height:220px;display:grid;place-items:start center;padding:28px;border:1px solid var(--line);border-radius:18px;background:radial-gradient(circle at 50% 0,rgba(255,255,255,.06),transparent 45%),#080c13;overflow:hidden}.philips-osd-demo,.philips-announcement{background:linear-gradient(180deg,rgba(34,39,47,.97),rgba(17,21,27,.98));border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 70px rgba(0,0,0,.5),inset 0 1px rgba(255,255,255,.07);border-radius:7px;color:#f8fafc;min-width:min(540px,90vw);max-width:min(680px,92vw);padding:16px 20px;display:flex;align-items:center;gap:13px}.philips-osd-demo{min-width:0;width:min(520px,100%)}.philips-osd-icon,.philips-announcement .osd-icon{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.11);font-weight:900;flex:0 0 auto}.philips-osd-copy{min-width:0}.philips-osd-copy b{display:block;font-size:14px;margin-bottom:3px}.philips-osd-copy span{display:block;color:#d6dbe2;line-height:1.4;overflow-wrap:anywhere}.philips-announcement{position:fixed;z-index:99999;top:22px;left:50%;transform:translate(-50%,-22px);opacity:0;pointer-events:none;transition:.28s cubic-bezier(.2,.8,.2,1)}.philips-announcement.show{transform:translate(-50%,0);opacity:1}.philips-announcement.hide{transform:translate(-50%,-18px);opacity:0}.philips-announcement .osd-main{min-width:0;flex:1}.philips-announcement .osd-title{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#aeb6c2;margin-bottom:4px}.philips-announcement .osd-text{font-size:15px;line-height:1.4;overflow-wrap:anywhere}.philips-announcement .osd-progress{position:absolute;left:0;bottom:0;height:2px;width:100%;background:rgba(255,255,255,.72);transform-origin:left center}.announcement-actions{display:flex;gap:10px;flex-wrap:wrap}.announcement-support{display:flex;flex-direction:column;gap:9px}.announcement-history{display:flex;flex-direction:column;gap:8px;margin-top:12px}.announcement-history-item{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--line);border-radius:12px}.announcement-history-item span{color:var(--muted);font-size:12px}@media(max-width:900px){.announcement-page-grid{grid-template-columns:1fr}.philips-announcement{top:12px;min-width:0;width:calc(100vw - 24px)}}`;
    document.head.append(s)
  }
  function inject(){
    if($('#view-announcements'))return;
    style();
    const nav=document.querySelector('.sidebar nav');
    const settings=nav?.querySelector('[data-view="settings"]');
    if(nav){const b=document.createElement('button');b.className='nav';b.dataset.view='announcements';b.innerHTML='▰ <span>Announcements</span>';if(settings)nav.insertBefore(b,settings);else nav.append(b);b.addEventListener('click',()=>openPage())}
    const main=document.querySelector('main');if(!main)return;
    const view=document.createElement('section');view.className='view';view.id='view-announcements';view.innerHTML=`
      <div class="announcement-page-grid">
        <div class="card announcement-editor">
          <div class="card-head"><div><span class="eyebrow">ANNOUNCEMENTS</span><h3>Philips-style melding</h3><p>Maak een tijdelijke melding die bovenaan in het midden van deze controller verschijnt.</p></div><span class="badge protected">Web-app OSD</span></div>
          <label>Tekst<textarea id="announcementText" maxlength="240" placeholder="Bijv. Film begint over 5 minuten!">Film begint over 5 minuten!</textarea></label>
          <div class="announcement-duration-row"><label>Zichtduur <input id="announcementDuration" type="range" min="1" max="30" value="5"><span id="announcementDurationValue">5 seconden</span></label><label>Exact<input id="announcementDurationNumber" type="number" min="1" max="60" value="5"> sec</label></div>
          <div class="announcement-actions"><button id="announcementShow" class="btn primary">▰ Show announcement</button><button id="announcementDismiss" class="btn ghost">Verberg nu</button></div>
          <div id="announcementMessage" class="notice subtle">Klaar om een melding te tonen.</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Live preview</h3><p>Zo ziet de melding eruit.</p></div></div>
          <div class="announcement-preview-box"><div class="philips-osd-demo"><div class="philips-osd-icon">i</div><div class="philips-osd-copy"><b>PHILIPS TV</b><span id="announcementPreviewText">Film begint over 5 minuten!</span></div></div></div>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><div><h3>TV overlay support</h3><p>Een vrije tekstmelding bovenop HDMI/TV vereist een OSD-notification endpoint van de televisie.</p></div><span class="badge offline">Niet exposed</span></div><div class="announcement-support"><div class="notice subtle"><b>JointSpace limitation</b><br><span>Op de bekende JointSpace v6 API van deze Philips-generatie is geen gedocumenteerd endpoint voor een eigen tekst-OSD beschikbaar. Daarom stuurt deze pagina niets nep naar de TV; de melding werkt in de controller zelf.</span></div></div><div id="announcementHistory" class="announcement-history"></div></div>`;
    main.append(view);bind();renderHistory()
  }
  function openPage(){
    $$('.view').forEach(v=>v.classList.toggle('active',v.id==='view-announcements'));
    $$('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view==='announcements'));
    const t=$('#pageTitle'),s=$('#pageSub');if(t)t.textContent='Announcements';if(s)s.textContent='Maak tijdelijke Philips-style meldingen in je Smart TV Controller.'
  }
  function duration(){return Math.max(1,Math.min(60,Number($('#announcementDurationNumber')?.value||$('#announcementDuration')?.value||5)))}
  function updatePreview(){const text=$('#announcementText')?.value.trim()||'Typ een melding…';const p=$('#announcementPreviewText');if(p)p.textContent=text}
  function syncRange(fromNumber=false){const r=$('#announcementDuration'),n=$('#announcementDurationNumber');let v=fromNumber?Number(n.value):Number(r.value);v=Math.max(1,Math.min(60,v||5));n.value=v;if(v<=30)r.value=v;$('#announcementDurationValue').textContent=`${v} seconde${v===1?'':'n'}`}
  function dismiss(){clearTimeout(timer);clearInterval(progressTimer);const old=$('#activePhilipsAnnouncement');if(old){old.classList.remove('show');old.classList.add('hide');setTimeout(()=>old.remove(),300)}}
  function saveHistory(text,seconds){let h=[];try{h=JSON.parse(localStorage.getItem('announcementHistory')||'[]')}catch{}h.unshift({text,seconds,at:Date.now()});h=h.slice(0,8);localStorage.setItem('announcementHistory',JSON.stringify(h));renderHistory()}
  function renderHistory(){const box=$('#announcementHistory');if(!box)return;let h=[];try{h=JSON.parse(localStorage.getItem('announcementHistory')||'[]')}catch{}box.innerHTML=h.length?'<b>Recente meldingen</b>':'<span class="muted">Nog geen meldingen getoond.</span>';h.forEach(x=>{const d=document.createElement('div');d.className='announcement-history-item';const b=document.createElement('b');b.textContent=x.text;const s=document.createElement('span');s.textContent=`${x.seconds}s`;d.append(b,s);d.onclick=()=>{$('#announcementText').value=x.text;$('#announcementDurationNumber').value=x.seconds;syncRange(true);updatePreview()};box.append(d)})}
  function show(){const text=$('#announcementText')?.value.trim();if(!text){$('#announcementMessage').className='notice warning';$('#announcementMessage').textContent='Typ eerst een melding.';return}const seconds=duration();dismiss();const o=document.createElement('div');o.id='activePhilipsAnnouncement';o.className='philips-announcement';o.innerHTML='<div class="osd-icon">i</div><div class="osd-main"><div class="osd-title">PHILIPS TV</div><div class="osd-text"></div></div><div class="osd-progress"></div>';o.querySelector('.osd-text').textContent=text;document.body.append(o);requestAnimationFrame(()=>o.classList.add('show'));const start=performance.now(),progress=o.querySelector('.osd-progress');progressTimer=setInterval(()=>{const left=Math.max(0,1-(performance.now()-start)/(seconds*1000));progress.style.transform=`scaleX(${left})`},40);timer=setTimeout(dismiss,seconds*1000);$('#announcementMessage').className='notice success';$('#announcementMessage').textContent=`Melding zichtbaar voor ${seconds} seconde${seconds===1?'':'n'}.`;saveHistory(text,seconds)}
  function bind(){
    $('#announcementText').addEventListener('input',updatePreview);$('#announcementDuration').addEventListener('input',()=>syncRange(false));$('#announcementDurationNumber').addEventListener('input',()=>syncRange(true));$('#announcementShow').addEventListener('click',show);$('#announcementDismiss').addEventListener('click',dismiss)
  }
  function boot(){inject()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();