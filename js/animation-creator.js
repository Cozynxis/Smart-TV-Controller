(() => {
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const KEY='ambilightSimpleAnimationsV2';
  const ed={topology:{left:0,top:0,right:0},leds:[],frames:[],selected:0,duration:5,fps:12,easing:'smoothstep',loop:true,pingpong:false,title:'Mijn animatie',emoji:'✨',description:'',color:'#168cff',brightness:100,previewing:false,previewId:null,previewStart:0};
  const rgb=h=>{h=String(h||'#000000').replace('#','').padEnd(6,'0').slice(0,6);return {r:parseInt(h.slice(0,2),16)||0,g:parseInt(h.slice(2,4),16)||0,b:parseInt(h.slice(4,6),16)||0}};
  const hex=c=>'#'+[c.r,c.g,c.b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
  const clone=o=>JSON.parse(JSON.stringify(o));
  const currentTv=()=>typeof state!=='undefined'?state.current:null;
  function black(){const p={};ed.leds.forEach(l=>p[l.id]='#000000');return p}
  function makeFrame(time,pixels){return {id:Math.random().toString(36).slice(2),time:Number(time)||0,pixels:pixels?clone(pixels):black()}}
  function current(){return ed.frames[ed.selected]||ed.frames[0]}
  function orderLeds(){const a=[];for(let i=0;i<ed.topology.left;i++)a.push({id:`left:${i}`,side:'left',index:i,pos:ed.topology.left<2?0:i/(ed.topology.left-1)});for(let i=0;i<ed.topology.top;i++)a.push({id:`top:${i}`,side:'top',index:i,pos:ed.topology.top<2?0:i/(ed.topology.top-1)});for(let i=0;i<ed.topology.right;i++)a.push({id:`right:${i}`,side:'right',index:i,pos:ed.topology.right<2?0:i/(ed.topology.right-1)});ed.leds=a}
  function ensureFrames(){if(!ed.frames.length)ed.frames=[makeFrame(0),makeFrame(ed.duration)];ed.frames.forEach(f=>ed.leds.forEach(l=>{if(!f.pixels[l.id])f.pixels[l.id]='#000000'}));ed.frames.sort((a,b)=>a.time-b.time);ed.selected=Math.min(ed.selected,ed.frames.length-1)}
  function currentFrame(){return current()}
  function point(l){const s=$('#simpleCreatorStage'),w=s?.clientWidth||760,h=s?.clientHeight||360,m=28;if(l.side==='left')return {x:m,y:h-m-l.pos*(h-2*m)};if(l.side==='top')return {x:m+l.pos*(w-2*m),y:m};return {x:w-m,y:m+l.pos*(h-2*m)}}
  function pctLit(p){let n=0;ed.leds.forEach(l=>{if((p[l.id]||'#000000').toLowerCase()!=='#000000')n++});return n}

  function inject(){
    const ambi=$('#view-ambilight');if(!ambi||$('#simpleAnimationCreator'))return;
    const box=document.createElement('section');box.id='simpleAnimationCreator';box.className='creator simple-creator card';
    box.innerHTML=`
      <div class="creator-title-row"><div><span class="eyebrow">CUSTOM AMBILIGHT</span><h3>🎬 Animation Maker</h3><p>Maak een animatie in 3 simpele stappen: kies een moment, klik lampjes aan, voeg het volgende moment toe.</p></div><span id="creatorConnection" class="badge protected">TV laden…</span></div>
      <div class="creator-steps"><div class="creator-step active"><b>1</b><span>Kies kleur</span></div><div class="creator-step"><b>2</b><span>Klik lampjes</span></div><div class="creator-step"><b>3</b><span>Nieuw moment</span></div></div>
      <div class="creator-meta simple-meta"><label>Emoji<input id="creatorEmoji" maxlength="4" value="✨"></label><label>Naam<input id="creatorTitle" maxlength="60" value="Mijn animatie"></label><label>Beschrijving<input id="creatorDesc" maxlength="140" placeholder="Bijv. blauw licht reist rond de TV"></label></div>
      <div class="creator-simple-tools"><label class="creator-color-big">Kleur<input id="creatorColor" type="color" value="#168cff"></label><label>Helderheid <b id="creatorBrightValue">100%</b><input id="creatorBrightness" type="range" min="5" max="100" value="100"></label><button id="creatorErase" class="btn ghost">Gum</button><button id="creatorAllOff" class="btn ghost">Alles uit</button></div>
      <div class="creator-stage-card"><div class="creator-stage-header"><div><b id="creatorMomentTitle">Moment 1 • 0.0 sec</b><small>Klik op een bolletje om dat lampje aan of uit te zetten.</small></div><span id="creatorLitCount">0 lampjes aan</span></div><div id="simpleCreatorStage" class="creator-stage"><div class="creator-screen"><b id="creatorScreenTitle">✨ Mijn animatie</b><small>TV</small></div></div><div id="creatorTopology" class="creator-topology">Ambilight-indeling laden…</div></div>
      <div class="simple-timeline-wrap"><div class="simple-timeline-head"><div><b>Momenten</b><small>Elk blokje is hoe de lampjes er op dat tijdstip uitzien.</small></div><button id="creatorAddFrame" class="btn primary">+ Volgend moment</button></div><div id="creatorFrames" class="simple-frames"></div></div>
      <div class="creator-help"><b>Zo maak je jouw blauwe lichtpunt:</b><span>Moment 1: alles uit, klik linksonder blauw. Klik “Volgend moment”. In moment 2 zet je het oude lampje uit en het volgende lampje iets hoger aan. Herhaal dit via links → boven → rechts. De TV maakt de beweging tussen de momenten automatisch soepel.</span></div>
      <details id="creatorAdvanced"><summary>Meer opties</summary><div class="advanced-grid"><label>Totale duur<input id="creatorDuration" type="number" min="0.5" max="120" step="0.5" value="5"> sec</label><label>FPS<select id="creatorFps"><option>8</option><option selected>12</option><option>16</option><option>20</option></select></label><label>Overgang<select id="creatorEasing"><option value="smoothstep" selected>Extra smooth</option><option value="linear">Linear</option><option value="ease-in">Langzaam starten</option><option value="ease-out">Langzaam stoppen</option></select></label><label class="creator-check"><input id="creatorLoop" type="checkbox" checked> Blijven herhalen</label><label class="creator-check"><input id="creatorPingpong" type="checkbox"> Heen en terug</label></div></details>
      <div class="creator-actions simple-actions"><button id="creatorPreview" class="btn secondary">▶ Voorbeeld hier</button><button id="creatorSend" class="btn primary">▶ Afspelen op TV</button><button id="creatorStop" class="btn danger-fill">■ Stop</button><button id="creatorSave" class="btn ghost">Opslaan</button><select id="creatorLibrary"><option value="">Mijn opgeslagen animaties…</option></select></div>
      <div id="creatorStatus" class="notice subtle">Nog niets actief.</div>`;
    ambi.append(box);bind();loadTopology();loadLibrary();
  }

  async function loadTopology(){
    const status=$('#creatorConnection'),tv=currentTv();
    try{
      if(!tv){status.textContent='Geen TV';status.className='badge offline';$('#creatorTopology').textContent='Verbind eerst je TV bovenaan de site.';return}
      const t=await api(`/api/ambilight/topology?deviceId=${encodeURIComponent(tv.id)}`);
      ed.topology={left:+t.left||0,top:+t.top||0,right:+t.right||0};orderLeds();ensureFrames();status.textContent='TV klaar';status.className='badge protected';render();
    }catch(e){status.textContent='Niet beschikbaar';status.className='badge offline';$('#creatorTopology').textContent='Kon Ambilight-indeling niet laden: '+e.message}
  }

  function colorWithBrightness(){const c=rgb(ed.color),f=ed.brightness/100;return hex({r:c.r*f,g:c.g*f,b:c.b*f})}
  function toggleLed(id,erase=false){const f=currentFrame();if(!f)return;const old=(f.pixels[id]||'#000000').toLowerCase();f.pixels[id]=(erase||old!=='#000000')?'#000000':colorWithBrightness();render()}
  function render(){
    const st=$('#simpleCreatorStage');if(!st)return;st.querySelectorAll('.creator-led').forEach(x=>x.remove());const f=currentFrame();
    ed.leds.forEach(l=>{const p=point(l),b=document.createElement('button');b.type='button';b.className='creator-led';b.dataset.id=l.id;b.style.left=p.x+'px';b.style.top=p.y+'px';const c=f?.pixels[l.id]||'#000000';b.style.background=c;b.classList.toggle('lit',c.toLowerCase()!=='#000000');b.title=`${l.side} lamp ${l.index+1}`;st.append(b)});
    $('#creatorTopology').textContent=`${ed.topology.left} links • ${ed.topology.top} boven • ${ed.topology.right} rechts`;
    $('#creatorScreenTitle').textContent=`${ed.emoji||'✨'} ${ed.title||'Mijn animatie'}`;
    $('#creatorMomentTitle').textContent=`Moment ${ed.selected+1} • ${(f?.time||0).toFixed(1)} sec`;
    $('#creatorLitCount').textContent=`${pctLit(f?.pixels||{})} lampjes aan`;
    renderFrames();
  }
  function renderFrames(){const box=$('#creatorFrames');box.innerHTML='';ed.frames.forEach((f,i)=>{const b=document.createElement('button');b.type='button';b.className='simple-frame'+(i===ed.selected?' active':'');b.innerHTML=`<b>${i+1}</b><span>${f.time.toFixed(1)} sec</span><small>${pctLit(f.pixels)} aan</small>`;b.onclick=()=>{ed.selected=i;render()};box.append(b)})}
  function addFrame(){const cur=currentFrame(),gap=Math.max(.25,ed.duration/8),nextTime=Math.min(ed.duration,cur.time+gap);if(nextTime===cur.time){ed.duration=Math.min(120,ed.duration+gap);$('#creatorDuration').value=ed.duration}ed.frames.push(makeFrame(nextTime===cur.time?ed.duration:nextTime,cur.pixels));ed.frames.sort((a,b)=>a.time-b.time);ed.selected=ed.frames.findIndex(f=>f.time===(nextTime===cur.time?ed.duration:nextTime));render();setStatus('Nieuw moment toegevoegd. Zet het oude licht uit en klik de nieuwe positie aan.')}
  function eraseAll(){currentFrame().pixels=black();render()}
  function sample(t){const fs=ed.frames;if(t<=fs[0].time)return fs[0].pixels;if(t>=fs.at(-1).time)return fs.at(-1).pixels;let a=fs[0],b=fs[1];for(let i=0;i<fs.length-1;i++){if(t>=fs[i].time&&t<=fs[i+1].time){a=fs[i];b=fs[i+1];break}}let k=(t-a.time)/Math.max(.001,b.time-a.time);if(ed.easing==='smoothstep')k=k*k*(3-2*k);else if(ed.easing==='ease-in')k=k*k;else if(ed.easing==='ease-out')k=1-(1-k)*(1-k);const out={};ed.leds.forEach(l=>{const x=rgb(a.pixels[l.id]),y=rgb(b.pixels[l.id]);out[l.id]=hex({r:x.r+(y.r-x.r)*k,g:x.g+(y.g-x.g)*k,b:x.b+(y.b-x.b)*k})});return out}
  function preview(){if(ed.previewing){stopPreview();return}ed.previewing=true;ed.previewStart=performance.now();$('#creatorPreview').textContent='■ Stop voorbeeld';const loop=now=>{if(!ed.previewing)return;let t=(now-ed.previewStart)/1000;if(ed.loop)t%=ed.duration;else if(t>ed.duration){stopPreview();return}const p=sample(t);$$('#simpleCreatorStage .creator-led').forEach(x=>{const c=p[x.dataset.id]||'#000000';x.style.background=c;x.classList.toggle('lit',c!=='#000000')});ed.previewId=requestAnimationFrame(loop)};ed.previewId=requestAnimationFrame(loop)}
  function stopPreview(){ed.previewing=false;if(ed.previewId)cancelAnimationFrame(ed.previewId);ed.previewId=null;$('#creatorPreview').textContent='▶ Voorbeeld hier';render()}
  function serialize(){return {version:2,title:ed.title||'Mijn animatie',emoji:ed.emoji||'✨',description:ed.description,duration:ed.duration,fps:ed.fps,easing:ed.easing,loop:ed.loop,pingpong:ed.pingpong,frames:ed.frames.map(f=>({time:f.time,pixels:f.pixels}))}}
  function setStatus(msg,type='subtle'){const el=$('#creatorStatus');el.className='notice '+type;el.textContent=msg}
  async function send(){
    const tv=currentTv();if(!tv)return setStatus('Verbind eerst je TV.','warning');
    if(ed.frames.length<2)return setStatus('Maak minimaal 2 momenten.','warning');
    stopPreview();window.__customAmbilightPlaying=true;
    try{await api('/api/ambilight/animation/stop',{method:'POST',body:JSON.stringify({deviceId:tv.id})}).catch(()=>{});const r=await api('/api/ambilight/custom/start',{method:'POST',body:JSON.stringify({deviceId:tv.id,animation:serialize()})});setStatus(`${r.emoji||'✨'} ${r.title||ed.title} speelt nu op de TV • ${r.fps} FPS`,'success')}
    catch(e){window.__customAmbilightPlaying=false;setStatus('Kon niet afspelen: '+e.message,'warning')}
  }
  async function stopTv(){const tv=currentTv();if(!tv)return;try{await api('/api/ambilight/custom/stop',{method:'POST',body:JSON.stringify({deviceId:tv.id})});window.__customAmbilightPlaying=false;setStatus('Animatie gestopt.','subtle')}catch(e){setStatus('Stoppen mislukt: '+e.message,'warning')}}
  function saveLocal(){const all=JSON.parse(localStorage.getItem(KEY)||'{}'),id='anim-'+Date.now();all[id]=serialize();localStorage.setItem(KEY,JSON.stringify(all));loadLibrary();setStatus('Animatie opgeslagen in deze browser.','success')}
  function loadLibrary(){const sel=$('#creatorLibrary');if(!sel)return;const all=JSON.parse(localStorage.getItem(KEY)||'{}');sel.innerHTML='<option value="">Mijn opgeslagen animaties…</option>';Object.entries(all).forEach(([id,a])=>{const o=document.createElement('option');o.value=id;o.textContent=`${a.emoji||'✨'} ${a.title||'Animatie'}`;sel.append(o)});sel.onchange=()=>{const a=all[sel.value];if(!a)return;ed.title=a.title||'Mijn animatie';ed.emoji=a.emoji||'✨';ed.description=a.description||'';ed.duration=+a.duration||5;ed.fps=+a.fps||12;ed.easing=a.easing||'smoothstep';ed.loop=a.loop!==false;ed.pingpong=!!a.pingpong;ed.frames=(a.frames||[]).map(f=>makeFrame(f.time,f.pixels));ed.selected=0;$('#creatorTitle').value=ed.title;$('#creatorEmoji').value=ed.emoji;$('#creatorDesc').value=ed.description;$('#creatorDuration').value=ed.duration;$('#creatorFps').value=ed.fps;$('#creatorEasing').value=ed.easing;$('#creatorLoop').checked=ed.loop;$('#creatorPingpong').checked=ed.pingpong;ensureFrames();render();setStatus('Opgeslagen animatie geladen.','success')}}
  function bind(){
    $('#creatorColor').oninput=e=>ed.color=e.target.value;$('#creatorBrightness').oninput=e=>{ed.brightness=+e.target.value;$('#creatorBrightValue').textContent=e.target.value+'%'};
    $('#creatorTitle').oninput=e=>{ed.title=e.target.value;render()};$('#creatorEmoji').oninput=e=>{ed.emoji=e.target.value;render()};$('#creatorDesc').oninput=e=>ed.description=e.target.value;
    $('#creatorAllOff').onclick=eraseAll;$('#creatorErase').onclick=()=>{ed.color='#000000';$('#creatorColor').value='#000000';setStatus('Gum actief: klik lampjes om ze uit te zetten.')};
    $('#creatorAddFrame').onclick=addFrame;$('#creatorPreview').onclick=preview;$('#creatorSend').onclick=send;$('#creatorStop').onclick=stopTv;$('#creatorSave').onclick=saveLocal;
    $('#creatorDuration').onchange=e=>{ed.duration=Math.max(.5,Math.min(120,+e.target.value||5));ed.frames.forEach(f=>f.time=Math.min(f.time,ed.duration));if(ed.frames.at(-1).time<ed.duration)ed.frames.at(-1).time=ed.duration;render()};$('#creatorFps').onchange=e=>ed.fps=+e.target.value;$('#creatorEasing').onchange=e=>ed.easing=e.target.value;$('#creatorLoop').onchange=e=>ed.loop=e.target.checked;$('#creatorPingpong').onchange=e=>ed.pingpong=e.target.checked;
    $('#simpleCreatorStage').addEventListener('click',e=>{const led=e.target.closest('.creator-led');if(led)toggleLed(led.dataset.id,ed.color==='#000000')});
    window.addEventListener('resize',()=>{if($('#view-ambilight')?.classList.contains('active'))render()});
  }

  window.refreshSimpleAnimationCreator=loadTopology;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',inject);else inject();
})();