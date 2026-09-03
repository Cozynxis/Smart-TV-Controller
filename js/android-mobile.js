(() => {
  const isMobile=()=>matchMedia('(max-width:820px), (pointer:coarse)').matches;
  function activeNav(){return document.querySelector('.sidebar .nav.active')}
  function keepActiveVisible(){if(!isMobile())return;const n=activeNav();try{n?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'})}catch{}}
  function haptic(ms=10){try{if(isMobile()&&navigator.vibrate&&localStorage.getItem('haptics')!=='false')navigator.vibrate(ms)}catch{}}
  function improveTouch(){
    document.documentElement.classList.toggle('android-touch',isMobile());
    document.querySelectorAll('button,.nav,.quick').forEach(el=>{
      if(el.dataset.mobileReady)return;el.dataset.mobileReady='1';
      el.addEventListener('pointerup',()=>haptic(el.classList.contains('danger')||el.classList.contains('danger-fill')?18:8),{passive:true});
    });
    keepActiveVisible();
  }
  function installObserver(){
    const target=document.body; if(!target)return;
    const ob=new MutationObserver(()=>improveTouch());
    ob.observe(target,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  }
  function installNavBehavior(){
    document.addEventListener('click',e=>{
      const nav=e.target.closest?.('.sidebar .nav');
      if(nav)setTimeout(keepActiveVisible,50);
    });
  }
  function installConnectionBanner(){
    if(document.getElementById('mobileConnectionPill'))return;
    const pill=document.createElement('div');pill.id='mobileConnectionPill';
    pill.style.cssText='display:none;position:fixed;z-index:9998;left:12px;right:12px;bottom:86px;padding:9px 12px;border-radius:14px;background:rgba(13,20,36,.94);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(18px);font:700 11px system-ui;color:#dbe3f3;align-items:center;justify-content:space-between;gap:10px;box-shadow:0 12px 35px #0008';
    pill.innerHTML='<span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#68748d;margin-right:7px"></i><b>TV verbinding</b></span><span data-mobile-connection style="color:#96a3ba">Controleren…</span>';
    document.body.appendChild(pill);
    const update=()=>{if(!isMobile()){pill.style.display='none';return}pill.style.display='flex';const bridge=document.getElementById('bridgeStatus');const badge=document.getElementById('connectionBadge');const online=(badge?.classList.contains('online')||document.getElementById('bridgeDot')?.classList.contains('online'));pill.querySelector('i').style.background=online?'#4ee0a1':'#68748d';pill.querySelector('[data-mobile-connection]').textContent=online?(badge?.textContent||'Verbonden'):(bridge?.textContent||'Offline')};
    setInterval(update,1500);update();
  }
  function boot(){improveTouch();installObserver();installNavBehavior();installConnectionBanner();addEventListener('resize',improveTouch,{passive:true});addEventListener('orientationchange',()=>setTimeout(improveTouch,150),{passive:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
