(() => {
  const effects={
    rainbow:{name:'Rainbow',icon:'🌈',desc:'A moving rainbow across left, top and right at the same time.'},
    aurora:{name:'Aurora',icon:'✦',desc:'Slow cyan, blue and violet movement across the Ambilight LEDs.'},
    ocean:{name:'Ocean',icon:'≈',desc:'Deep-blue and turquoise waves with gentle brightness changes.'},
    sunset:{name:'Sunset Flow',icon:'◒',desc:'Warm orange, pink and purple tones flowing around the TV.'},
    breathe:{name:'Breathe',icon:'◌',desc:'All sides breathe smoothly in a calm violet tone.'},
    neon:{name:'Neon Dream',icon:'◇',desc:'Magenta, violet and electric-blue movement.'}
  };
  const CUSTOM_KEY='ambilightSimpleAnimationsV3';
  const ui={effect:null,running:false,poll:null,previewTimer:null,previewHue:0,customId:null,customCache:''};
  let injected=false;
  const el=s=>document.querySelector(s),els=s=>[...document.querySelectorAll(s)];
  function hsv(h,s,v){h=((h%360)+360)%360;s/=100;v/=100;const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;let r=0,g=0,b=0;if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}return '#'+[r,g,b].map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('')}
  const deviceId=()=>state?.current?.id||(state?.current?.ip?`philips:${state.current.ip}`:null);
  function speed(){return Number(el('#ambiAnimSpeed')?.value||65)}
  function setStatus(running,effect,frames){ui.running=running;ui.effect=running?effect:null;if(running)ui.customId=null;const b=el('#ambiAnimStatus');if(b){b.textContent=running?`${effects[effect]?.name||effect} • ${frames||0} frames`:ui.customId?'Custom running':'Stopped';b.className=`effect-status ${(running||ui.customId)?'running':''}`}els('[data-effect]').forEach(x=>x.classList.toggle('active',running&&x.dataset.effect===effect));if(el('#stopAmbiAnim'))el('#stopAmbiAnim').disabled=!(running||ui.customId)}
  function previewStart(){clearInterval(ui.previewTimer);ui.previewTimer=setInterval(()=>{if(!ui.running&&!ui.customId)return;ui.previewHue=(ui.previewHue+2+speed()/22)%360;const p=el('#ambiAnimPreview');if(p)p.style.background=`linear-gradient(90deg,${hsv(ui.previewHue,95,100)},${hsv(ui.previewHue+110,95,100)},${hsv(ui.previewHue+220,95,100)})`;const t=el('#ambiAnimColour');if(t)t.textContent=ui.customId?'Custom timeline streaming':'Bridge streaming';},45)}
  async function startAnimation(effect){const id=deviceId();if(!id)return toast('Connect a TV first');try{await stopCustom(false);const r=await api('/api/ambilight/animation/start',{method:'POST',body:JSON.stringify({deviceId:id,effect,speed:speed()})});state.zones={left:true,top:true,right:true};if(typeof renderZones==='function')renderZones();setStatus(true,effect,0);previewStart();if(el('#zoneModeHint'))el('#zoneModeHint').textContent=`Animation active: ${effects[effect].name} • left + top + right`;toast(`${effects[effect].name} started on the bridge`);pollStatus()}catch(e){toast(`Animation: ${typeof controlError==='function'?controlError(e):e.message}`)}}
  async function stopAnimation(show=true){const id=deviceId();if(id)try{await api('/api/ambilight/animation/stop',{method:'POST',body:JSON.stringify({deviceId:id})})}catch{}setStatus(false);clearInterval(ui.previewTimer);if(el('#zoneModeHint'))el('#zoneModeHint').textContent='Custom Zone mode';if(show)toast('Ambilight animation stopped')}
  async function pollStatus(){clearTimeout(ui.poll);const id=deviceId();if(!id)return;try{const r=await api(`/api/ambilight/animation/status?deviceId=${encodeURIComponent(id)}`);if(!ui.customId)setStatus(!!r.running,r.effect,r.frames);if(r.running)ui.poll=setTimeout(pollStatus,850)}catch{}}

  function readCustom(){try{return JSON.parse(localStorage.getItem(CUSTOM_KEY)||'{}')}catch{return {}}}
  function scaledAnimation(a,speedPct){
    const factor=Math.max(.2,Math.min(3,Number(speedPct||100)/100));
    const copy=JSON.parse(JSON.stringify(a));
    copy.duration=Math.max(.2,Number(copy.duration||5)/factor);
    copy.frames=(copy.frames||[]).map(f=>({...f,time:Number(f.time||0)/factor}));
    copy.fps=Math.max(4,Math.min(25,Number(copy.fps||12)));
    return copy;
  }
  function renderCustomAnimations(){
    const box=el('#customAmbiAnimations');if(!box)return;
    const all=readCustom(),entries=Object.entries(all);
    box.innerHTML='';
    if(!entries.length){box.innerHTML='<div class="custom-empty">Nog geen custom animaties. Maak en bewaar er eentje in de Animation Maker hieronder.</div>';return}
    entries.forEach(([id,a])=>{
      const item=document.createElement('div');item.className='custom-effect-tile'+(ui.customId===id?' active':'');item.dataset.customId=id;
      item.innerHTML=`<div class="custom-effect-main"><span class="custom-effect-icon">${a.emoji||'✨'}</span><div><b>${a.title||'Custom animation'}</b><small>${a.description||`${(a.frames||[]).length} momenten • ${Number(a.duration||0).toFixed(1)} sec`}</small></div></div><div class="custom-effect-controls"><label>Speed <span class="custom-speed-value">100%</span><input class="custom-speed" type="range" min="25" max="250" value="100"></label><button class="btn primary custom-play">▶ Play</button></div>`;
      const slider=item.querySelector('.custom-speed'),val=item.querySelector('.custom-speed-value');slider.oninput=()=>val.textContent=slider.value+'%';
      item.querySelector('.custom-play').onclick=()=>startCustom(id,a,Number(slider.value));box.append(item);
    });
  }
  async function startCustom(customId,a,speedPct){
    const id=deviceId();if(!id)return toast('Connect a TV first');
    try{
      await stopAnimation(false);await stopCustom(false);
      const anim=scaledAnimation(a,speedPct);
      const r=await api('/api/ambilight/custom/start',{method:'POST',body:JSON.stringify({deviceId:id,animation:anim})});
      ui.customId=customId;ui.running=false;ui.effect=null;els('.custom-effect-tile').forEach(x=>x.classList.toggle('active',x.dataset.customId===customId));
      const b=el('#ambiAnimStatus');if(b){b.textContent=`${r.emoji||'✨'} ${r.title||a.title} • custom`;b.className='effect-status running'}if(el('#stopAmbiAnim'))el('#stopAmbiAnim').disabled=false;
      if(el('#zoneModeHint'))el('#zoneModeHint').textContent=`Custom animation active: ${a.title||'Custom'}`;previewStart();toast(`${a.emoji||'✨'} ${a.title||'Custom animation'} gestart • ${speedPct}% speed`);
    }catch(e){ui.customId=null;toast(`Custom animation: ${e.message}`)}
  }
  async function stopCustom(show=false){const id=deviceId();if(id)try{await api('/api/ambilight/custom/stop',{method:'POST',body:JSON.stringify({deviceId:id})})}catch{}const was=!!ui.customId;ui.customId=null;els('.custom-effect-tile').forEach(x=>x.classList.remove('active'));if(show&&was)toast('Custom animation stopped')}
  async function stopEverything(){await stopAnimation(false);await stopCustom(false);setStatus(false);if(el('#stopAmbiAnim'))el('#stopAmbiAnim').disabled=true;toast('Ambilight animation stopped')}

  function modeHelp(mode){const map={FOLLOW_VIDEO:['Follow video','The TV itself follows the picture. Pick a video preset and press Apply mode.'],FOLLOW_AUDIO:['Follow audio','The TV reacts to audio using the selected Philips algorithm.'],FOLLOW_COLOR:['Follow colour','A fixed Philips colour mode. For individual sides, use Custom Zones.'],FLAG:['Flag','Uses a built-in flag palette when your firmware exposes it.'],OFF:['Off','Turns Ambilight off and stops any running animation.']};return map[mode]||['Ambilight mode','Choose a mode and press Apply mode.']}
  function refreshModeHelp(){const box=el('#ambiModeHelp');if(!box)return;const [a,b]=modeHelp(el('#ambiMode')?.value);box.innerHTML=`<b>${a}</b><span>${b}</span>`}
  function cleanRemote(){const n=el('#remoteNotice');if(!n)return;if(n.classList.contains('warning')){n.className='notice subtle';n.innerHTML='<b>Remote uses the separate secure connection</b><br><span>If it is not paired yet, use Remote activeren on the Remote page.</span>'}}
  function cleanApps(){const status=el('#appsStatus'),grid=el('#appsGrid');if(!status||!grid)return;if(status.classList.contains('warning')||/unavailable|not exposed|not available/i.test(status.textContent)){status.className='notice subtle';status.innerHTML='<b>App library not exposed by this TV connection</b><br><span>The controller will keep the TV connected. Android TV information and all other supported pages remain available.</span>';grid.className='apps-grid empty';grid.innerHTML='<div class="empty-feature"><b>No app tiles to display</b><span>Your firmware does not return an installed-app list through this JointSpace connection.</span></div>'}}
  function inject(){
    if(injected)return;injected=true;const ambi=el('#view-ambilight');if(!ambi)return;
    const grid=ambi.querySelector('.grid.two');if(grid){const guide=document.createElement('div');guide.className='ambi-guide card';guide.innerHTML='<div class="card-head"><div><h3>Ambilight control</h3><p>Normal modes are handled by the TV. Custom Zones and Animations use direct LED control. Starting one automatically replaces the previous manual effect.</p></div><span class="badge protected">Bridge v0.7+</span></div><div id="ambiModeHelp" class="mode-help"></div>';grid.before(guide)}
    const card=document.createElement('div');card.className='card animation-card';card.innerHTML=`<div class="card-head"><div><h3>Ambilight Animations</h3><p>Preset animations + all animations you save in the Animation Maker.</p></div><span id="ambiAnimStatus" class="effect-status">Stopped</span></div><div class="animation-layout"><div><div class="effect-grid">${Object.entries(effects).map(([id,x])=>`<button class="effect-tile" data-effect="${id}"><span>${x.icon}</span><b>${x.name}</b><small>${x.desc}</small></button>`).join('')}</div><div class="custom-animation-divider"><span>YOUR CUSTOM ANIMATIONS</span></div><div id="customAmbiAnimations" class="custom-effect-grid"></div></div><div class="animation-panel"><div class="anim-preview-wrap"><div id="ambiAnimPreview" class="anim-preview"></div><div><small>Streaming mode</small><b id="ambiAnimColour">Bridge idle</b></div></div><label>Preset animation speed <span id="ambiAnimSpeedValue">65%</span><input id="ambiAnimSpeed" type="range" min="1" max="100" value="65"></label><div class="animation-note"><b>Custom speed</b><span>Each saved custom animation has its own speed slider from 25% to 250%.</span></div><button id="stopAmbiAnim" class="btn danger-fill wide" disabled>Stop animation</button></div></div>`;
    ambi.append(card);els('[data-effect]').forEach(b=>b.addEventListener('click',()=>startAnimation(b.dataset.effect)));el('#stopAmbiAnim')?.addEventListener('click',stopEverything);el('#ambiAnimSpeed')?.addEventListener('input',e=>{if(el('#ambiAnimSpeedValue'))el('#ambiAnimSpeedValue').textContent=`${e.target.value}%`});el('#ambiAnimSpeed')?.addEventListener('change',()=>{if(ui.running&&ui.effect)startAnimation(ui.effect)});el('#ambiMode')?.addEventListener('change',refreshModeHelp);refreshModeHelp();renderCustomAnimations();previewStart();pollStatus();
    setInterval(()=>{const raw=localStorage.getItem(CUSTOM_KEY)||'';if(raw!==ui.customCache){ui.customCache=raw;renderCustomAnimations()}},700);
  }
  const oldApply=typeof applyAmbilight==='function'?applyAmbilight:null;if(oldApply)applyAmbilight=async function(...a){await stopEverything();return oldApply(...a)};
  const oldZones=typeof applyZones==='function'?applyZones:null;if(oldZones)applyZones=async function(...a){await stopEverything();return oldZones(...a)};
  const oldRemote=typeof updateRemoteNotice==='function'?updateRemoteNotice:null;if(oldRemote)updateRemoteNotice=function(...a){oldRemote(...a);cleanRemote()};
  const oldApps=typeof loadApps==='function'?loadApps:null;if(oldApps)loadApps=async function(...a){await oldApps(...a);cleanApps()};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',inject);else inject();
})();