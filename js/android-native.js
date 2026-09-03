(()=>{
  if(!window.AndroidNative)return;
  const pending=new Map();
  let seq=0;
  const originalFetch=window.fetch.bind(window);
  window.__nativeResolve=(id,status,text)=>{
    const p=pending.get(id);if(!p)return;pending.delete(id);
    let data={};try{data=text?JSON.parse(text):{}}catch{data={message:text}}
    p.resolve({
      ok:status>=200&&status<300,
      status,
      statusText:String(status),
      headers:new Headers({'content-type':'application/json'}),
      text:async()=>text||'',
      json:async()=>data,
      clone(){return this}
    });
  };
  function nativePath(input){
    const raw=typeof input==='string'?input:(input?.url||'');
    try{
      const u=new URL(raw,location.href);
      if(u.pathname.startsWith('/api/'))return u.pathname+u.search;
      if(u.pathname==='/api')return u.pathname+u.search;
    }catch{}
    if(/^\/api(?:\/|\?|$)/.test(raw))return raw;
    return null;
  }
  window.fetch=(input,init={})=>{
    const path=nativePath(input);
    if(!path)return originalFetch(input,init);
    const id='a'+Date.now().toString(36)+(++seq).toString(36);
    const method=String(init.method||'GET').toUpperCase();
    const body=typeof init.body==='string'?init.body:(init.body==null?'':JSON.stringify(init.body));
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      try{window.AndroidNative.request(id,method,path,body)}catch(e){pending.delete(id);reject(e)}
      setTimeout(()=>{const p=pending.get(id);if(p){pending.delete(id);p.reject(new Error('Android TV request timed out'))}},20000);
    });
  };
  localStorage.setItem('bridgeUrl','http://android-native');
  window.__ANDROID_TV_APP__=true;
  console.log('[ANDROID] Native TV bridge active - no laptop required');
})();
