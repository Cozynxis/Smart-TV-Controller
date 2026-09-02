(() => {
  const MAIN_KEY='ambilightSimpleAnimationsV3';
  const OLD_KEYS=['ambilightSimpleAnimationsV1','ambilightSimpleAnimationsV2'];
  const $=s=>document.querySelector(s);
  const $$=s=>[...document.querySelectorAll(s)];
  const clone=v=>JSON.parse(JSON.stringify(v));
  const currentDeviceId=()=>{
    try{
      if(typeof state!=='undefined'&&state?.current){
        return state.current.id||(state.current.ip?`philips:${state.current.ip}`:null);
      }
    }catch{}
    try{
      const t=JSON.parse(localStorage.getItem('currentTv')||'null');
      return t?.id||(t?.ip?`philips:${t.ip}`:null);
    }catch{return null}
  };
  function safeObject(raw){
    try{const x=typeof raw==='string'?JSON.parse(raw):raw;return x&&typeof x==='object'?x:{}}catch{return {}}
  }
  function frameArray(a){
    if(!a)return [];
    let src=a.frames??a.steps??a.keyframes??a.moments??a.timeline??[];
    if(typeof src==='string'){try{src=JSON.parse(src)}catch{src=[]}}
    if(src&&!Array.isArray(src)&&typeof src==='object')src=Object.values(src);
    if(!Array.isArray(src))return [];
    return src.map((f,i)=>{
      if(!f||typeof f!=='object')return null;
      const pixels=f.pixels??f.lights??f.leds??f.colors??{};
      return {time:Number(f.time??f.at??f.second??f.seconds??(i*.5))||0,pixels:pixels&&typeof pixels==='object'?clone(pixels):{}};
    }).filter(Boolean).sort((a,b)=>a.time-b.time);
  }
  function normalize(a){
    if(typeof a==='string'){try{a=JSON.parse(a)}catch{a={}}}
    if(a?.animation)a=typeof a.animation==='string'?safeObject(a.animation):a.animation;
    a=a&&typeof a==='object'?a:{};
    const frames=frameArray(a);
    let duration=Number(a.duration||0);
    if(!duration&&frames.length)duration=Math.max(.5,Number(frames.at(-1)?.time||0)+.5);
    if(frames.length===1){frames.push({time:Math.max(.5,duration||.5),pixels:clone(frames[0].pixels)});duration=Math.max(duration,.5)}
    return {version:4,title:a.title||a.name||'Custom animation',emoji:a.emoji||'✨',description:a.description||'',duration:Math.max(.5,duration||5),fps:Math.max(4,Math.min(25,Number(a.fps)||12)),easing:a.easing||'smoothstep',loop:a.loop!==false,pingpong:!!a.pingpong,frames};
  }
  function readAll(){
    const all=safeObject(localStorage.getItem(MAIN_KEY)||'{}');
    for(const key of OLD_KEYS){
      const old=safeObject(localStorage.getItem(key)||'{}');
      for(const [id,a] of Object.entries(old))if(!all[id])all[id]=a;
    }
    return all;
  }
  function migrate(){
    const all=readAll(),fixed={};let changed=false;
    for(const [id,a] of Object.entries(all)){
      const n=normalize(a);fixed[id]=n;
      if(JSON.stringify(n)!==JSON.stringify(a))changed=true;
    }
    if(changed||!localStorage.getItem(MAIN_KEY))localStorage.setItem(MAIN_KEY,JSON.stringify(fixed));
    return fixed;
  }
  async function callApi(path,opts={}){
    try{if(typeof api==='function')return await api(path,opts)}catch{}
    let bridge='http://localhost:8765';
    try{bridge=(typeof state!=='undefined'&&state?.bridgeUrl)||localStorage.getItem('bridgeUrl')||bridge}catch{}
    const r=await fetch(bridge.replace(/\/$/,'')+path,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}}),text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={message:text}}if(!r.ok)throw new Error(data.error||data.message||`HTTP ${r.status}`);return data;
  }
  function notify(text){try{if(typeof toast==='function')return toast(text)}catch{}console.log('[CUSTOM]',text)}
  function deleteAnimation(id){
    const all=migrate();const a=all[id];if(!a)return;
    if(!confirm(`“${a.title||'Custom animation'}” volledig verwijderen?`))return;
    delete all[id];localStorage.setItem(MAIN_KEY,JSON.stringify(all));
    window.dispatchEvent(new Event('custom-animations-changed'));
    document.querySelector(`.custom-effect-tile[data-custom-id="${CSS.escape(id)}"]`)?.remove();
    const select=$('#creatorLibrary');if(select?.value===id)select.value='';
    notify('Custom animation verwijderd');
  }
  function installTrash(){
    $$('.custom-effect-tile').forEach(tile=>{
      if(tile.querySelector('.custom-delete'))return;
      const b=document.createElement('button');b.type='button';b.className='custom-delete';b.title='Animatie volledig verwijderen';b.setAttribute('aria-label','Animatie verwijderen');b.textContent='🗑️';
      b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();deleteAnimation(tile.dataset.customId)});
      tile.append(b);
    });
  }
  async function playSaved(tile){
    const id=tile?.dataset?.customId,all=migrate(),raw=all[id];
    if(!raw)return notify('Deze animatie bestaat niet meer.');
    const anim=normalize(raw),deviceId=currentDeviceId();
    if(!deviceId)return notify('Verbind eerst de TV.');
    if(anim.frames.length<2)return notify('Deze oude save bevat geen bruikbare momenten meer. Open hem in de maker en voeg minimaal 2 momenten toe.');
    const speed=Number(tile.querySelector('.custom-speed')?.value||100),factor=Math.max(.2,Math.min(3,speed/100));
    const send=clone(anim);send.duration=Math.max(.2,send.duration/factor);send.frames=send.frames.map(f=>({...f,time:Number(f.time||0)/factor}));
    try{
      await callApi('/api/ambilight/animation/stop',{method:'POST',body:JSON.stringify({deviceId})}).catch(()=>{});
      await callApi('/api/ambilight/custom/stop',{method:'POST',body:JSON.stringify({deviceId})}).catch(()=>{});
      const r=await callApi('/api/ambilight/custom/start',{method:'POST',body:JSON.stringify({deviceId,animation:send})});
      $$('.custom-effect-tile').forEach(x=>x.classList.toggle('active',x===tile));
      const s=$('#ambiAnimStatus');if(s){s.textContent=`${r.emoji||send.emoji} ${r.title||send.title} • custom`;s.className='effect-status running'}
      notify(`${send.emoji} ${send.title} gestart • ${speed}% speed`);
    }catch(e){notify(`Custom animation: ${e.message}`)}
  }
  function injectStyle(){if($('#customFixStyle'))return;const s=document.createElement('style');s.id='customFixStyle';s.textContent=`.custom-effect-tile{position:relative}.custom-delete{position:absolute;right:10px;top:10px;width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,95,95,.25);background:rgba(255,70,70,.08);color:inherit;display:grid;place-items:center;cursor:pointer;font-size:15px;transition:.16s}.custom-delete:hover{transform:scale(1.06);background:rgba(255,70,70,.16);border-color:rgba(255,95,95,.55)}.custom-effect-main{padding-right:42px}`;document.head.append(s)}
  function boot(){
    injectStyle();migrate();
    document.addEventListener('click',e=>{
      const play=e.target.closest('.custom-play');if(!play)return;
      const tile=play.closest('.custom-effect-tile');if(!tile)return;
      e.preventDefault();e.stopImmediatePropagation();playSaved(tile);
    },true);
    const obs=new MutationObserver(()=>installTrash());obs.observe(document.body,{childList:true,subtree:true});installTrash();
    window.addEventListener('custom-animations-changed',()=>setTimeout(installTrash,50));
    setInterval(()=>{migrate();installTrash()},1200);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();