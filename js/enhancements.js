(() => {
  const effects = {
    rainbow: { name: 'Rainbow', icon: '🌈', desc: 'Smoothly cycles every Ambilight side through the full colour spectrum.' },
    aurora: { name: 'Aurora', icon: '✦', desc: 'Slow blue, cyan and violet movement inspired by northern lights.' },
    ocean: { name: 'Ocean', icon: '≈', desc: 'A calm deep-blue to turquoise flowing animation.' },
    sunset: { name: 'Sunset Flow', icon: '◒', desc: 'Warm amber, orange, pink and purple tones that drift slowly.' },
    breathe: { name: 'Breathe', icon: '◌', desc: 'A soft colour that gently brightens and dims without harsh flashing.' },
    neon: { name: 'Neon Dream', icon: '◇', desc: 'Smooth magenta, violet and electric-blue transitions.' }
  };

  const anim = { running:false, effect:null, timer:null, step:0, busy:false };
  let injected = false;

  function el(s){ return document.querySelector(s); }
  function els(s){ return [...document.querySelectorAll(s)]; }
  function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
  function hsvToHex(h,s,v){
    h=((h%360)+360)%360;s=clamp(s,0,100)/100;v=clamp(v,0,100)/100;
    const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;let r=0,g=0,b=0;
    if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}
    return '#'+[r,g,b].map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('');
  }
  function wave(a,b,t){ return a+(b-a)*(0.5-0.5*Math.cos(t*Math.PI*2)); }
  function colourFor(effect,step){
    const t=step/100;
    if(effect==='rainbow') return hsvToHex((step*3.2)%360,94,100);
    if(effect==='aurora') return hsvToHex(wave(165,285,t*.35),82,wave(58,96,t*.62));
    if(effect==='ocean') return hsvToHex(wave(185,228,t*.28),88,wave(55,94,t*.48));
    if(effect==='sunset') return hsvToHex(wave(8,328,t*.18),82,wave(68,100,t*.36));
    if(effect==='breathe') return hsvToHex(268,72,wave(26,100,t*.22));
    if(effect==='neon') return hsvToHex(wave(278,325,t*.42),92,wave(62,100,t*.58));
    return '#7c5cff';
  }
  function speedDelay(){
    const n=Number(el('#ambiAnimSpeed')?.value||58);
    return Math.round(720-(clamp(n,1,100)*5.9));
  }
  function updateAnimUi(){
    const badge=el('#ambiAnimStatus');
    if(badge){badge.textContent=anim.running?`${effects[anim.effect]?.name||'Effect'} running`:'Stopped';badge.className=`effect-status ${anim.running?'running':''}`;}
    els('[data-effect]').forEach(b=>b.classList.toggle('active',anim.running&&b.dataset.effect===anim.effect));
    const stop=el('#stopAmbiAnim');if(stop)stop.disabled=!anim.running;
  }
  function stopAnimation(showToast=true){
    anim.running=false;anim.effect=null;anim.busy=false;clearTimeout(anim.timer);anim.timer=null;updateAnimUi();
    if(showToast && typeof toast==='function') toast('Ambilight animation stopped');
  }
  async function tick(){
    if(!anim.running || !state?.current || anim.busy) return;
    anim.busy=true;
    const colour=colourFor(anim.effect,anim.step++);
    const swatch=el('#ambiAnimPreview');if(swatch)swatch.style.background=colour;
    const txt=el('#ambiAnimColour');if(txt)txt.textContent=colour.toUpperCase();
    if(el('#ambiColor')) el('#ambiColor').value=colour;
    if(el('#zoneColor')) el('#zoneColor').value=colour;
    try{
      await api('/api/ambilight',{method:'POST',body:JSON.stringify({deviceId:state.current.id,mode:'FOLLOW_COLOR',preset:'CUSTOM_COLOR',color:colour})});
      const hint=el('#zoneModeHint');if(hint)hint.textContent=`Animation: ${effects[anim.effect]?.name||anim.effect} • all sides on`;
    }catch(e){
      stopAnimation(false);
      if(typeof toast==='function') toast(`Animation stopped: ${typeof controlError==='function'?controlError(e):e.message}`);
      return;
    }finally{ anim.busy=false; }
    if(anim.running) anim.timer=setTimeout(tick,speedDelay());
  }
  async function startAnimation(effect){
    if(!state?.current){ if(typeof toast==='function') toast('Connect a TV first'); return; }
    stopAnimation(false);
    if(state.zones){state.zones.left=true;state.zones.top=true;state.zones.right=true;if(typeof renderZones==='function')renderZones();}
    anim.running=true;anim.effect=effect;anim.step=0;updateAnimUi();
    if(typeof toast==='function') toast(`${effects[effect].name} started • left + top + right enabled`);
    await tick();
  }

  function modeHelp(mode){
    const map={
      FOLLOW_VIDEO:['Follow video','Ambilight follows the colours and movement of the picture. Choose a video preset underneath.'],
      FOLLOW_AUDIO:['Follow audio','Ambilight reacts to sound. The preset controls the visual algorithm; tuning adjusts its variation.'],
      FOLLOW_COLOR:['Follow colour','Use a Philips colour preset or Custom Color. For individual sides use Custom Zones on the right.'],
      FLAG:['Flag','Displays a built-in flag palette when your firmware supports that preset.'],
      OFF:['Off','Turns Ambilight off. Any running animation is stopped first.']
    };
    return map[mode]||['Ambilight mode','Choose a mode and press Apply.'];
  }
  function refreshModeHelp(){
    const box=el('#ambiModeHelp');if(!box)return;const [title,text]=modeHelp(el('#ambiMode')?.value);box.innerHTML=`<b>${title}</b><span>${text}</span>`;
  }
  function inject(){
    if(injected)return;injected=true;
    const ambi=el('#view-ambilight');if(!ambi)return;
    const grid=ambi.querySelector('.grid.two');
    if(grid){
      const guide=document.createElement('div');guide.className='ambi-guide card';guide.innerHTML=`<div class="card-head"><div><h3>How Ambilight control works</h3><p>Pick a normal TV mode, create custom left/top/right zones, or run one smooth animation. Starting one type automatically stops the previous animation.</p></div><span class="badge protected">No re-pairing</span></div><div id="ambiModeHelp" class="mode-help"></div>`;
      grid.before(guide);
    }
    const card=document.createElement('div');card.className='card animation-card';card.innerHTML=`
      <div class="card-head"><div><h3>Ambilight Animations</h3><p>Smooth bridge-driven colour effects. No flashing/strobe effects are included.</p></div><span id="ambiAnimStatus" class="effect-status">Stopped</span></div>
      <div class="animation-layout">
        <div class="effect-grid">${Object.entries(effects).map(([id,x])=>`<button class="effect-tile" data-effect="${id}"><span>${x.icon}</span><b>${x.name}</b><small>${x.desc}</small></button>`).join('')}</div>
        <div class="animation-panel">
          <div class="anim-preview-wrap"><div id="ambiAnimPreview" class="anim-preview"></div><div><small>Live target colour</small><b id="ambiAnimColour">#7C5CFF</b></div></div>
          <label>Animation speed <span id="ambiAnimSpeedValue">58%</span><input id="ambiAnimSpeed" type="range" min="1" max="100" value="58"></label>
          <div class="animation-note"><b>Smooth mode</b><span>The next frame is only sent after the TV accepts the previous one, so requests never stack up.</span></div>
          <button id="stopAmbiAnim" class="btn danger-fill wide" disabled>Stop animation</button>
        </div>
      </div>`;
    ambi.append(card);
    els('[data-effect]').forEach(b=>b.addEventListener('click',()=>startAnimation(b.dataset.effect)));
    el('#stopAmbiAnim')?.addEventListener('click',()=>stopAnimation());
    el('#ambiAnimSpeed')?.addEventListener('input',e=>{const x=el('#ambiAnimSpeedValue');if(x)x.textContent=`${e.target.value}%`;});
    el('#ambiMode')?.addEventListener('change',refreshModeHelp);
    refreshModeHelp();updateAnimUi();
  }

  const originalApplyAmbilight = typeof applyAmbilight==='function' ? applyAmbilight : null;
  if(originalApplyAmbilight){
    applyAmbilight = async function(...args){ stopAnimation(false); return originalApplyAmbilight(...args); };
  }
  const originalApplyZones = typeof applyZones==='function' ? applyZones : null;
  if(originalApplyZones){
    applyZones = async function(...args){ stopAnimation(false); return originalApplyZones(...args); };
  }
  const originalRemoteNotice = typeof updateRemoteNotice==='function' ? updateRemoteNotice : null;
  if(originalRemoteNotice){
    updateRemoteNotice = function(error){
      originalRemoteNotice(error);
      const n=el('#remoteNotice');if(!n)return;
      if(n.classList.contains('warning')) n.textContent='Remote keys are not available through the current TV connection. Your TV stays connected and Ambilight, status and other available features keep working. No PIN request is started automatically.';
    };
  }
  const originalLoadApps = typeof loadApps==='function' ? loadApps : null;
  if(originalLoadApps){
    loadApps = async function(...args){
      await originalLoadApps(...args);
      const s=el('#appsStatus');if(s?.classList.contains('warning')) s.textContent='Installed app discovery is not available through this TV firmware connection. The TV is still connected; use the Android TV page to see which other services are available.';
    };
  }

  window.addEventListener('beforeunload',()=>stopAnimation(false));
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',inject); else inject();
})();