(()=>{
  const FAV_KEY='smartTvAppFavoritesV1';
  function current(){try{return typeof state!=='undefined'&&state?state.current:JSON.parse(localStorage.getItem('currentTv')||'null')}catch{return null}}
  async function call(path,opts={}){if(typeof api==='function')return api(path,opts);const bridge=(localStorage.getItem('bridgeUrl')||location.origin).replace(/\/$/,'');const r=await fetch(bridge+path,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});const text=await r.text();let d={};try{d=text?JSON.parse(text):{}}catch{d={error:text}}if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d}
  function loadFavs(){try{return new Set(JSON.parse(localStorage.getItem(FAV_KEY)||'[]'))}catch{return new Set()}}
  function saveFavs(s){localStorage.setItem(FAV_KEY,JSON.stringify([...s]))}
  function toastIt(msg){if(typeof toast==='function')toast(msg);else console.log(msg)}
  function appFromTile(tile){const packageName=tile.querySelector('small')?.textContent?.trim()||'';const name=tile.querySelector('b')?.textContent?.trim()||'';const id=tile.dataset.key||packageName||name;return {id,packageName:packageName.includes('.')?packageName:'',name}}
  document.addEventListener('click',async e=>{
    const fav=e.target.closest('.app-fav');
    if(fav){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();const tile=fav.closest('.app-modern');if(!tile)return;const app=appFromTile(tile),key=tile.dataset.key||app.packageName||app.name,s=loadFavs();if(s.has(key)){s.delete(key);fav.classList.remove('on');toastIt(`${app.name} uit favorieten verwijderd`)}else{s.add(key);fav.classList.add('on');toastIt(`${app.name} toegevoegd aan favorieten`)}saveFavs(s);if(typeof window.loadApps==='function')setTimeout(()=>window.loadApps(true),50);return}
    const tile=e.target.closest('.app-modern');
    if(!tile)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    const tv=current();if(!tv)return toastIt('Verbind eerst een TV.');const app=appFromTile(tile);tile.classList.add('opening');
    try{await call('/api/apps/open',{method:'POST',body:JSON.stringify({deviceId:tv.id||`philips:${tv.ip}`,app})});toastIt(`${app.name} wordt geopend…`);setTimeout(()=>{if(typeof window.loadApps==='function')window.loadApps(true)},1200)}catch(err){toastIt(`App openen mislukt: ${err.message}`)}finally{tile.classList.remove('opening')}
  },true);
  const style=document.createElement('style');style.textContent='.app-modern.opening{transform:scale(.98);opacity:.72}.app-modern{cursor:pointer}.app-fav{cursor:pointer}';document.head.append(style);
  console.log('[APPS UI HOTFIX] Tile opening + favorites v1 ready');
})();