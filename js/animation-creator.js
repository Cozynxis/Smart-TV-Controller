(() => {
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const KEY='ambilightSimpleAnimationsV3';
  const ed={topology:{left:0,top:0,right:0},leds:[],frames:[],selected:0,duration:5,fps:12,easing:'smoothstep',loop:true,pingpong:false,title:'Mijn animatie',emoji:'✨',description:'',color:'#168cff',brightness:100,previewing:false,previewId:null,previewStart:0,retry:null,loading:false};
  const clone=o=>JSON.parse(JSON.stringify(o));
  const rgb=h=>{h=String(h||'#000000').replace('#','').padEnd(6,'0').slice(0,6);return {r:parseInt(h.slice(0,2),16)||0,g:parseInt(h.slice(2,4),16)||0,b:parseInt(h.slice(4,6),16)||0}};
  const hex=c=>'#'+[c.r,c.g,c.b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
  const currentTv=()=>typeof state!=='undefined'&&state?state.current:null;
  function black(){const p={};ed.leds.forEach(l=>p[l.id]='#000000');return p}
  function makeFrame(time,pixels){return {id:Math.random().toString(36).slice(2),time:Number(time)||0,pixels:pixels?clone(pixels):black()}}
  function current(){return ed.frames[ed.selected]||ed.frames[0]}
  function countPixels(x){if(!x||typeof x!=='object')return 0;return Object.keys(x).length}
  function parseTopology(raw){
    const t=raw?.topology||raw||{};
    let left=Number(t.left||0),top=Number(t.top||0),right=Number(t.right||0);
    const cached=raw?.cached?.layer1||raw?.layer1||{};
    if(!left)left=countPixels(cached.left);
    if(!top)top=countPixels(cached.top);
    if(!right)right=countPixels(cached.right);
    return {left,top,right};
  }
  function orderLeds(){
    const a=[];
    for(let i=0;i<ed.topology.left;i++)a.push({id:`left:${i}`,side:'left',index:i,pos:ed.topology.left<2?0:i/(ed.topology.left-1)});
    for(let i=0;i<ed.topology.top;i++)a.push({id:`top:${i}`,side:'top',index:i,pos:ed.topology.top<2?0:i/(ed.topology.top-1)});
    for(let i=0;i<ed.topology.right;i++)a.push({id:`right:${i}`,side:'right',index:i,pos:ed.topology.right<2?0:i/(ed.topology.right-1)});
    ed.leds=a;
  }
  function ensureFrames(){
    if(!ed.frames.length)ed.frames=[makeFrame(0)];
    ed.frames.forEach(f=>ed.leds.forEach(l=>{if(typeof f.pixels[l.id]!=='string')f.pixels[l.id]='#000000'}));
    ed.frames.sort((a,b)=>a.time-b.time);ed.selected=Math.min(ed.selected,ed.frames.length-1);
  }
  function point(l){
    const s=$('#simpleCreatorStage'),w=Math.max(320,s?.clientWidth||760),h=Math.max(260,s?.clientHeight||360),m=32;
    if(l.side==='left')return {x:m,y:h-m-l.pos*(h-2*m)};
    if(l.side==='top')return {x:m+l.pos*(w-2*m),y:m};
    return {x:w-m,y:m+l.pos*(h-2*m)};
  }
  function litCount(p){let n=0;ed.leds.forEach(l=>{if(String(p?.[l.id]||'#000000').toLowerCase()!=='#000000')n++});return n}
  function status(msg,type='subtle'){const x=$('#creatorStatus');if(x){x.className='notice '+type;x.textContent=msg}}

  function inject(){
    const ambi=$('#view-ambilight');if(!ambi||$('#simpleAnimationCreator'))return;
    const box=document.createElement('section');box.id='simpleAnimationCreator';box.className='creator simple-creator card';box.innerHTML=`
      <div class="creator-title-row"><div><span class="eyebrow">CUSTOM AMBILIGHT</span><h3>🎬 Animation Maker</h3><p>Heel simpel: kies kleur → klik LED-bolletjes → maak het volgende moment.</p></div><span id="creatorConnection" class="badge protected">TV zoeken…</span></div>
      <div class="creator-steps"><div class="creator-step active"><b>1</b><span>Kies kleur</span></div><div class="creator-step active"><b>2</b><span>Klik bolletjes</span></div><div class="creator-step active"><b>3</b><span>Volgend moment</span></div></div>
      <div class="creator-meta simple-meta"><label>Emoji<input id="creatorEmoji" maxlength="4" value="✨"></label><label>Naam<input id="creatorTitle" maxlength="60" value="Mijn animatie"></label><label>Beschrijving<input id="creatorDesc" maxlength="140" placeholder="Bijv. blauw licht reist rond de TV"></label></div>
      <div class="creator-simple-tools"><label class="creator-color-big">Kleur<input id="creatorColor" type="color" value="#168cff"></label><label>Helderheid <b id="creatorBrightValue">100%</b><input id="creatorBrightness" type="range" min="5" max="100" value="100"></label><button id="creatorErase" class="btn ghost">Gum: UIT</button><button id="creatorAllOff" class="btn ghost">Alles uit</button></div>
      <div class="creator-stage-card">
        <div class="creator-stage-header"><div><b id="creatorMomentTitle">Moment 1 • 0.0 sec</b><small>Klik rechtstreeks op de ronde LED-punten rond de TV.</small></div><span id="creatorLitCount">0 lampjes aan</span></div>
        <div id="simpleCreatorStage" class="creator-stage"><div class="creator-screen"><b id="creatorScreenTitle">✨ Mijn animatie</b><small>TV</small></div><div id="creatorNoLeds" class="creator-no-leds">LED-layout wordt geladen…</div></div>
        <div class="creator-layout-row"><span id="creatorTopology" class="creator-topology">Ambilight-indeling laden…</span><button id="creatorReloadLayout" class="btn ghost small">↻ LED-layout opnieuw laden</button></div>
      </div>
      <div class="simple-timeline-wrap"><div class="simple-timeline-head"><div><b>Momenten</b><small>Een nieuw moment begint expres helemaal UIT.</small></div><button id="creatorAddFrame" class="btn primary">+ Volgend moment (alles uit)</button></div><div id="creatorFrames" class="simple-frames"></div></div>
      <div class="creator-help"><b>Voor jouw bewegende blauwe punt:</b><span>Moment 1: klik alleen linksonder blauw. Klik daarna “Volgend moment”; dat nieuwe moment is helemaal zwart. Klik daar één LED iets hoger. Herhaal via links → boven → rechts. Zo blijven niet ineens alle lampjes aan.</span></div>
      <details id="creatorAdvanced"><summary>Meer opties</summary><div class="advanced-grid"><label>Totale duur<input id="creatorDuration" type="number" min="0.5" max="120" step="0.5" value="5"> sec</label><label>FPS<select id="creatorFps"><option>8</option><option selected>12</option><option>16</option><option>20</option></select></label><label>Overgang<select id="creatorEasing"><option value="smoothstep" selected>Extra smooth</option><option value="linear">Linear</option><option value="ease-in">Langzaam starten</option><option value="ease-out">Langzaam stoppen</option></select></label><label class="creator-check"><input id="creatorLoop" type="checkbox" checked> Blijven herhalen</label><label class="creator-check"><input id="creatorPingpong" type="checkbox"> Heen en terug</label></div></details>
      <div class="creator-actions simple-actions"><button id="creatorPreview" class="btn secondary">▶ Voorbeeld hier</button><button id="creatorSend" class="btn primary">▶ Afspelen op TV</button><button id="creatorStop" class="btn danger-fill">■ Stop</button><button id="creatorSave" class="btn ghost">Opslaan</button><select id="creatorLibrary"><option value="">Mijn opgeslagen animaties…</option></select></div>
      <div id="creatorStatus" class="notice subtle">Wachten op de TV-layout.</div>`;
    ambi.append(box);bind();loadLibrary();loadTopology(true);
  }

  async function loadTopology(auto=false){
    if(ed.loading)return;ed.loading=true;clearTimeout(ed.retry);
    const badge=$('#creatorConnection'),label=$('#creatorTopology'),tv=currentTv();
    try{
      if(!tv){
        badge.textContent='TV wordt verbonden…';badge.className='badge offline';label.textContent='Wachten tot de normale TV-verbinding klaar is…';
        if(auto)ed.retry=setTimeout(()=>loadTopology(true),800);return;
      }
      badge.textContent='LED-layout laden…';badge.className='badge protected';
      let raw=await api(`/api/ambilight/topology?deviceId=${encodeURIComponent(tv.id)}`);
      let t=parseTopology(raw);
      if(!t.left&&!t.top&&!t.right){
        const info=await api(`/api/ambilight/info?deviceId=${encodeURIComponent(tv.id)}`);
        t=parseTopology(info);
      }
      if(!t.left&&!t.top&&!t.right)throw new Error('TV gaf geen LED-aantallen terug');
      ed.topology=t;orderLeds();ensureFrames();badge.textContent='TV klaar';badge.className='badge protected';status(`${ed.leds.length} LED-punten geladen. Klik op een bolletje.`,'success');render();
    }catch(e){
      badge.textContent='Opnieuw proberen…';badge.className='badge offline';label.textContent='LED-layout nog niet klaar: '+e.message;
      if(auto)ed.retry=setTimeout(()=>loadTopology(true),1200);
    }finally{ed.loading=false}
  }

  function colorWithBrightness(){const c=rgb(ed.color),f=ed.brightness/100;return hex({r:c.r*f,g:c.g*f,b:c.b*f})}
  function paintLed(id,erase){const f=current();if(!f)return;f.pixels[id]=erase?'#000000':colorWithBrightness();render()}
  function toggleLed(id,erase){const f=current();if(!f)return;if(erase)return paintLed(id,true);const old=String(f.pixels[id]||'#000000').toLowerCase();f.pixels[id]=old==='#000000'?colorWithBrightness():'#000000';render()}
  function render(){
    const st=$('#simpleCreatorStage');if(!st)return;st.querySelectorAll('.creator-led').forEach(x=>x.remove());
    const no=$('#creatorNoLeds');if(no)no.style.display=ed.leds.length?'none':'grid';const f=current();
    ed.leds.forEach(l=>{const p=point(l),b=document.createElement('button');b.type='button';b.className='creator-led';b.dataset.id=l.id;b.dataset.side=l.side;b.style.left=p.x+'px';b.style.top=p.y+'px';const c=f?.pixels[l.id]||'#000000';b.style.setProperty('--led-color',c);b.style.backgroundColor=c;b.classList.toggle('lit',c.toLowerCase()!=='#000000');b.setAttribute('aria-label',`${l.side} lamp ${l.index+1}`);b.title=`${l.side} lamp ${l.index+1}`;st.append(b)});
    $('#creatorTopology').textContent=ed.leds.length?`${ed.leds.length} bolletjes • ${ed.topology.left} links • ${ed.topology.top} boven • ${ed.topology.right} rechts`:'Geen LED-punten geladen';
    $('#creatorScreenTitle').textContent=`${ed.emoji||'✨'} ${ed.title||'Mijn animatie'}`;$('#creatorMomentTitle').textContent=`Moment ${ed.selected+1} • ${(f?.time||0).toFixed(1)} sec`;$('#creatorLitCount').textContent=`${litCount(f?.pixels)} lampjes aan`;renderFrames();
  }
  function renderFrames(){const box=$('#creatorFrames');if(!box)return;box.innerHTML='';ed.frames.forEach((f,i)=>{const b=document.createElement('button');b.type='button';b.className='simple-frame'+(i===ed.selected?' active':'');b.innerHTML=`<b>${i+1}</b><span>${f.time.toFixed(1)} sec</span><small>${litCount(f.pixels)} aan</small>`;b.addEventListener('click',()=>{ed.selected=i;render()});box.append(b)})}
  function addFrame(){
    if(!ed.leds.length)return status('De LED-layout is nog niet geladen. Klik op “LED-layout opnieuw laden”.','warning');
    const last=Math.max(...ed.frames.map(f=>f.time),0),next=Math.round((last+.5)*10)/10;ed.duration=Math.max(ed.duration,next+.5);$('#creatorDuration').value=ed.duration;ed.frames.push(makeFrame(next,black()));ed.frames.sort((a,b)=>a.time-b.time);ed.selected=ed.frames.findIndex(f=>f.time===next);render();status(`Moment ${ed.selected+1} toegevoegd: alle LEDs staan UIT. Klik nu alleen de lampjes aan die je hier wilt.`,'success');
  }
  function eraseAll(){const f=current();if(!f)return;f.pixels=black();render();status('Dit moment staat nu volledig uit.')}
  function sample(t){const fs=ed.frames.slice().sort((a,b)=>a.time-b.time);if(!fs.length)return{};if(t<=fs[0].time)return fs[0].pixels;if(t>=fs.at(-1).time)return fs.at(-1).pixels;let a=fs[0],b=fs[1];for(let i=0;i<fs.length-1;i++){if(t>=fs[i].time&&t<=fs[i+1].time){a=fs[i];b=fs[i+1];break}}let k=(t-a.time)/Math.max(.001,b.time-a.time);if(ed.easing==='smoothstep')k=k*k*(3-2*k);else if(ed.easing==='ease-in')k=k*k;else if(ed.easing==='ease-out')k=1-(1-k)*(1-k);const out={};ed.leds.forEach(l=>{const x=rgb(a.pixels[l.id]),y=rgb(b.pixels[l.id]);out[l.id]=hex({r:x.r+(y.r-x.r)*k,g:x.g+(y.g-x.g)*k,b:x.b+(y.b-x.b)*k})});return out}
  function preview(){if(ed.frames.length<2)return status('Maak eerst minimaal 2 momenten.','warning');if(ed.previewing){stopPreview();return}ed.previewing=true;ed.previewStart=performance.now();$('#creatorPreview').textContent='■ Stop voorbeeld';const loop=now=>{if(!ed.previewing)return;let t=(now-ed.previewStart)/1000;if(ed.loop)t%=ed.duration;else if(t>ed.duration){stopPreview();return}const p=sample(t);$$('#simpleCreatorStage .creator-led').forEach(x=>{const c=p[x.dataset.id]||'#000000';x.style.backgroundColor=c;x.style.setProperty('--led-color',c);x.classList.toggle('lit',c!=='#000000')});ed.previewId=requestAnimationFrame(loop)};ed.previewId=requestAnimationFrame(loop)}
  function stopPreview(){ed.previewing=false;if(ed.previewId)cancelAnimationFrame(ed.previewId);ed.previewId=null;const b=$('#creatorPreview');if(b)b.textContent='▶ Voorbeeld hier';render()}
  function serialize(){return {version:3,title:ed.title||'Mijn animatie',emoji:ed.emoji||'✨',description:ed.description,duration:ed.duration,fps:ed.fps,easing:ed.easing,loop:ed.loop,pingpong:ed.pingpong,frames:ed.frames.map(f=>({time:f.time,pixels:f.pixels}))}}
  async function send(){const tv=currentTv();if(!tv)return status('De TV is nog niet verbonden.','warning');if(ed.frames.length<2)return status('Maak minimaal 2 momenten.','warning');stopPreview();window.__customAmbilightPlaying=true;try{await api('/api/ambilight/animation/stop',{method:'POST',body:JSON.stringify({deviceId:tv.id})}).catch(()=>{});const r=await api('/api/ambilight/custom/start',{method:'POST',body:JSON.stringify({deviceId:tv.id,animation:serialize()})});status(`${r.emoji||'✨'} ${r.title||ed.title} speelt nu op de TV • ${r.fps} FPS`,'success')}catch(e){window.__customAmbilightPlaying=false;status('Afspelen mislukt: '+e.message,'warning')}}
  async function stopTv(){const tv=currentTv();if(!tv)return;try{await api('/api/ambilight/custom/stop',{method:'POST',body:JSON.stringify({deviceId:tv.id})});window.__customAmbilightPlaying=false;status('Animatie gestopt.')}catch(e){status('Stoppen mislukt: '+e.message,'warning')}}
  function saveLocal(){const all=JSON.parse(localStorage.getItem(KEY)||'{}'),id='anim-'+Date.now();all[id]=serialize();localStorage.setItem(KEY,JSON.stringify(all));loadLibrary();status('Animatie opgeslagen.','success')}
  function loadLibrary(){const sel=$('#creatorLibrary');if(!sel)return;const all=JSON.parse(localStorage.getItem(KEY)||'{}');sel.innerHTML='<option value="">Mijn opgeslagen animaties…</option>';Object.entries(all).forEach(([id,a])=>{const o=document.createElement('option');o.value=id;o.textContent=`${a.emoji||'✨'} ${a.title||'Animatie'}`;sel.append(o)});sel.onchange=()=>{const a=all[sel.value];if(!a)return;Object.assign(ed,{title:a.title||'Mijn animatie',emoji:a.emoji||'✨',description:a.description||'',duration:+a.duration||5,fps:+a.fps||12,easing:a.easing||'smoothstep',loop:a.loop!==false,pingpong:!!a.pingpong,selected:0});ed.frames=(a.frames||[]).map(f=>makeFrame(f.time,f.pixels));$('#creatorTitle').value=ed.title;$('#creatorEmoji').value=ed.emoji;$('#creatorDesc').value=ed.description;$('#creatorDuration').value=ed.duration;$('#creatorFps').value=ed.fps;$('#creatorEasing').value=ed.easing;$('#creatorLoop').checked=ed.loop;$('#creatorPingpong').checked=ed.pingpong;ensureFrames();render();status('Opgeslagen animatie geladen.','success')}}
  function bind(){
    let erasing=false,drag=false;
    const st=$('#simpleCreatorStage');
    st.addEventListener('click',e=>{const l=e.target.closest('.creator-led');if(l)toggleLed(l.dataset.id,erasing)});
    st.addEventListener('pointerdown',e=>{const l=e.target.closest('.creator-led');if(!l)return;drag=true;e.preventDefault()});
    st.addEventListener('pointermove',e=>{if(!drag)return;const l=document.elementFromPoint(e.clientX,e.clientY)?.closest('.creator-led');if(l)paintLed(l.dataset.id,erasing)});
    window.addEventListener('pointerup',()=>drag=false);
    $('#creatorColor').oninput=e=>ed.color=e.target.value;$('#creatorBrightness').oninput=e=>{ed.brightness=+e.target.value;$('#creatorBrightValue').textContent=e.target.value+'%'};
    $('#creatorTitle').oninput=e=>{ed.title=e.target.value;render()};$('#creatorEmoji').oninput=e=>{ed.emoji=e.target.value;render()};$('#creatorDesc').oninput=e=>ed.description=e.target.value;
    $('#creatorErase').onclick=()=>{erasing=!erasing;$('#creatorErase').textContent='Gum: '+(erasing?'AAN':'UIT');$('#creatorErase').classList.toggle('primary',erasing)};$('#creatorAllOff').onclick=eraseAll;$('#creatorReloadLayout').onclick=()=>loadTopology(false);$('#creatorAddFrame').onclick=addFrame;
    $('#creatorDuration').onchange=e=>ed.duration=Math.max(.5,Math.min(120,+e.target.value||5));$('#creatorFps').onchange=e=>ed.fps=+e.target.value;$('#creatorEasing').onchange=e=>ed.easing=e.target.value;$('#creatorLoop').onchange=e=>ed.loop=e.target.checked;$('#creatorPingpong').onchange=e=>ed.pingpong=e.target.checked;
    $('#creatorPreview').onclick=preview;$('#creatorSend').onclick=send;$('#creatorStop').onclick=stopTv;$('#creatorSave').onclick=saveLocal;
    window.addEventListener('resize',()=>{if(ed.leds.length)render()});
  }
  function boot(){inject();let tries=0;const watcher=setInterval(()=>{tries++;if($('#simpleAnimationCreator')&&currentTv()&&(!ed.leds.length||$('#creatorConnection')?.textContent!=='TV klaar'))loadTopology(true);if(ed.leds.length||tries>30)clearInterval(watcher)},700)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();