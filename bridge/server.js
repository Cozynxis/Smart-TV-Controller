const express=require('express');
const cors=require('cors');
const {Client}=require('node-ssdp');
const fs=require('fs');
const path=require('path');
const os=require('os');
const https=require('https');
const crypto=require('crypto');
const net=require('net');

const app=express();
const PORT=Number(process.env.PORT||8765);
const ROOT=path.resolve(__dirname,'..');
const STORE=path.join(__dirname,'devices.local.json');
const VERSION='0.7.0';
const PAIR_SECRET='ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==';
const pairSessions=new Map();
const pairLocks=new Map();
const routeCache=new Map();
const ambiAnimations=new Map();

app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Private-Network','true');res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');next()});
app.use(cors({origin:true,methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type']}));
app.options('*',cors());
app.use(express.json({limit:'1mb'}));
app.use(express.static(ROOT,{etag:false,lastModified:false,maxAge:0}));

let store={devices:{}};
try{store=JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{}
function persist(){fs.writeFileSync(STORE,JSON.stringify(store,null,2))}
function getSaved(id){return store.devices[id]||null}
function saveDevice(d){const id=d.id||`${d.brand||'philips'}:${d.ip}`;store.devices[id]={...(store.devices[id]||{}),...d,id};persist();return store.devices[id]}
function sanitizeDevice(d){if(!d)return d;const x={...d};delete x.credentials;return x}
function parseJson(t){try{return t?JSON.parse(t):{}}catch{return {raw:t}}}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function timeoutSignal(ms){return typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(ms):undefined}
function err(message,status,code,data){const e=new Error(message);e.status=status;e.code=code;e.data=data;return e}

async function httpResponse(url,{method='GET',body,timeoutMs=5000}={}){
  const r=await fetch(url,{method,headers:{Accept:'application/json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:timeoutSignal(timeoutMs)});
  const text=await r.text();
  return {status:r.status,ok:r.ok,data:parseJson(text),headers:Object.fromEntries(r.headers.entries())};
}
async function httpJson(url,opts={}){const r=await httpResponse(url,opts);if(!r.ok)throw err(r.data.error||r.data.message||`HTTP ${r.status}`,r.status,'http_error',r.data);return r.data}
function cleanEndpoint(e){return String(e||'').replace(/^\/+|\/+$/g,'')}
function httpCandidates(d,endpoint){const clean=cleanEndpoint(endpoint),preferred=Number(d.apiVersion||6),versions=[preferred,...[6,1].filter(v=>v!==preferred)];return [...new Set([...versions.map(v=>`http://${d.ip}:1925/${v}/${clean}`),`http://${d.ip}:1925/${clean}`])]}
function routeKey(d,e,m){return `${d.ip}|${String(m||'GET').toUpperCase()}|${cleanEndpoint(e)}`}
async function httpTvRequest(d,endpoint,{method='GET',body}={}){
  const key=routeKey(d,endpoint,method),cached=routeCache.get(key),urls=httpCandidates(d,endpoint),ordered=cached?[cached,...urls.filter(x=>x!==cached)]:urls;
  let last=null;
  for(const url of ordered){
    try{
      const r=await httpResponse(url,{method,body,timeoutMs:5500});
      if(r.ok){routeCache.set(key,url);console.log(`[TV] ${method} ${cleanEndpoint(endpoint)} -> ${new URL(url).pathname} (${r.status})`);return r.data}
      if(r.status===404){last=err(`HTTP 404 at ${new URL(url).pathname}`,404,'not_found');continue}
      throw err(r.data.error||r.data.message||`HTTP ${r.status}`,r.status,'http_error',r.data)
    }catch(e){last=e;if(e.status===404)continue;throw e}
  }
  throw last||err(`No working HTTP route for ${endpoint}`,404,'not_found')
}

async function tryHttpJointSpace(ip){const errors=[];for(const v of [6,1]){try{const data=await httpJson(`http://${ip}:1925/${v}/system`,{timeoutMs:3500});console.log(`[HTTP] ${ip} JointSpace /${v} works on port 1925`);return {ok:true,data,apiVersion:v}}catch(e){errors.push(`/${v}: ${e.message}`)}}try{const data=await httpJson(`http://${ip}:1925/system`,{timeoutMs:3500});return {ok:true,data,apiVersion:Number(data.api_version?.Major||6),unversioned:true}}catch(e){errors.push(`/system: ${e.message}`)}return {ok:false,error:errors.join(' | ')}}

function httpsResponse(url,{method='GET',body,headers={},timeoutMs=7500}={}){return new Promise((resolve,reject)=>{const u=new URL(url),payload=body==null?null:(typeof body==='string'?body:JSON.stringify(body));let done=false;const finish=(fn,v)=>{if(done)return;done=true;fn(v)};const req=https.request({hostname:u.hostname,port:Number(u.port||443),path:u.pathname+u.search,method,rejectUnauthorized:false,timeout:timeoutMs,headers:{Accept:'application/json','User-Agent':`Smart-TV-Controller/${VERSION}`,...(payload!==null?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>finish(resolve,{status:res.statusCode||0,headers:res.headers,data:parseJson(text)}));res.on('error',e=>finish(reject,e))});req.on('timeout',()=>req.destroy(Object.assign(new Error('TV request timed out'),{code:'ETIMEDOUT'})));req.on('error',e=>finish(reject,e));if(payload!==null)req.write(payload);req.end()})}
function parseDigest(header=''){const src=String(Array.isArray(header)?header[0]:header).replace(/^Digest\s+/i,''),o={};const re=/(\w+)=(?:"([^"]*)"|([^,\s]+))/g;let m;while((m=re.exec(src)))o[m[1].toLowerCase()]=m[2]??m[3];return o}
function hash(alg,s){const a=String(alg||'MD5').toUpperCase(),n=a.startsWith('SHA-256')?'sha256':a.startsWith('SHA-512-256')?'sha512-256':'md5';return crypto.createHash(n).update(s).digest('hex')}
function digestAuth(url,method,creds,challenge){const c=parseDigest(challenge);if(!c.realm||!c.nonce)throw new Error('Invalid Digest challenge');const u=new URL(url),uri=u.pathname+u.search,alg=c.algorithm||'MD5',cnonce=crypto.randomBytes(8).toString('hex'),nc='00000001',qop=String(c.qop||'').split(',').map(x=>x.trim().replace(/^"|"$/g,'')).find(x=>x==='auth')||'';let ha1=hash(alg,`${creds.username}:${c.realm}:${creds.password}`);if(String(alg).toLowerCase().endsWith('-sess'))ha1=hash(alg,`${ha1}:${c.nonce}:${cnonce}`);const ha2=hash(alg,`${method}:${uri}`),response=qop?hash(alg,`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`):hash(alg,`${ha1}:${c.nonce}:${ha2}`),p=[`username="${creds.username}"`,`realm="${c.realm}"`,`nonce="${c.nonce}"`,`uri="${uri}"`,`response="${response}"`];if(c.algorithm)p.push(`algorithm=${c.algorithm}`);if(c.opaque)p.push(`opaque="${c.opaque}"`);if(qop)p.push(`qop=${qop}`,`nc=${nc}`,`cnonce="${cnonce}"`);return `Digest ${p.join(', ')}`}
async function secureJson(url,{method='GET',body}={},creds){const u=new URL(url),probe=await httpsResponse(`${u.protocol}//${u.host}/6/system`,{method:'GET',timeoutMs:6500});if(probe.status!==401||!probe.headers['www-authenticate'])throw err(`Digest challenge failed (HTTP ${probe.status})`,probe.status,'digest_failed');let auth=digestAuth(url,method,creds,probe.headers['www-authenticate']),r=await httpsResponse(url,{method,body,headers:{Authorization:auth},timeoutMs:8500});if(r.status===401&&r.headers['www-authenticate']){auth=digestAuth(url,method,creds,r.headers['www-authenticate']);r=await httpsResponse(url,{method,body,headers:{Authorization:auth},timeoutMs:8500})}if(r.status<200||r.status>=300)throw err(r.data.error_text||r.data.error||r.data.message||`HTTP ${r.status}`,r.status,'secure_http_error',r.data);return r.data}

function randomId(){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';let out='';for(let i=0;i<16;i++)out+=chars[crypto.randomInt(chars.length)];return out}
function pairingDevice(id){return {device_name:'Smart TV Controller',device_os:process.platform==='win32'?'Windows':'Desktop',app_name:'Smart TV Controller',type:'native',app_id:'app.id',id}}
function pairingSignature(ts,pin){const key=Buffer.from(PAIR_SECRET,'base64'),hex=crypto.createHmac('sha1',key).update(String(ts)+String(pin)).digest('hex');return Buffer.from(hex).toString('base64')}
function sessionAlive(s){return s&&Date.now()-s.createdAt<Math.max(90000,Number(s.timeout||60)*1000+20000)}
function pairTransport(ip,body){return new Promise((resolve,reject)=>{const payload=JSON.stringify(body),req=https.request({hostname:ip,port:1926,path:'/6/pair/request',method:'POST',rejectUnauthorized:false,timeout:7000,headers:{Accept:'application/json',Connection:'close','Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,data:parseJson(text)}))});req.on('timeout',()=>req.destroy(Object.assign(new Error('TV request timed out'),{code:'ETIMEDOUT'})));req.on('error',reject);req.write(payload);req.end()})}
async function createPair(ip){const old=pairSessions.get(ip);if(sessionAlive(old))return {ok:true,reused:true,timeout:old.timeout,message:'Er is al een actieve PIN.'};const deviceId=randomId(),body={scope:['read','write','control'],device:pairingDevice(deviceId)},r=await pairTransport(ip,body);if(r.status<200||r.status>=300)throw new Error(r.data.error_text||r.data.error||`HTTP ${r.status}`);if(!r.data.auth_key||r.data.timestamp===undefined)throw new Error('TV returned no pairing credentials');const s={deviceId,authKey:r.data.auth_key,timestamp:r.data.timestamp,createdAt:Date.now(),timeout:r.data.timeout||60};pairSessions.set(ip,s);saveDevice({id:`philips:${ip}`,ip,brand:'philips',apiMode:'secure',pairingPending:true});return {ok:true,timeout:s.timeout,message:'PIN aangevraagd. Kijk op de TV.'}}
async function pairRequest(ip){if(pairLocks.has(ip))return pairLocks.get(ip);const p=createPair(ip).finally(()=>pairLocks.delete(ip));pairLocks.set(ip,p);return p}
async function pairGrant(ip,pin){const s=pairSessions.get(ip);if(!sessionAlive(s))throw new Error('PIN-sessie verlopen. Vraag een nieuwe PIN aan.');const code=String(pin).trim();if(!/^\d{4,8}$/.test(code))throw new Error('Ongeldige PIN.');const creds={username:s.deviceId,password:s.authKey},body={auth:{auth_AppId:'1',pin:code,auth_timestamp:s.timestamp,auth_signature:pairingSignature(s.timestamp,code)},device:pairingDevice(s.deviceId)},data=await secureJson(`https://${ip}:1926/6/pair/grant`,{method:'POST',body},creds);if(data.error_id&&data.error_id!=='SUCCESS')throw new Error(data.error_text||data.error_id);const old=getSaved(`philips:${ip}`)||{},d=saveDevice({...old,id:`philips:${ip}`,ip,brand:'philips',apiMode:'secure',credentials:creds,paired:true,pairingPending:false});pairSessions.delete(ip);return {ok:true,device:sanitizeDevice(d)}}

async function optional(fn){try{return {ok:true,data:await fn()}}catch(e){return {ok:false,error:e.message,status:e.status||null,code:e.code||null}}}
async function tvRequest(d,endpoint,{method='GET',body,control=false}={}){if(d.apiMode==='http'){try{return await httpTvRequest(d,endpoint,{method,body})}catch(e){if((e.status===404||e.status===401||e.status===403)&&d.credentials)return secureJson(`https://${d.ip}:1926/6/${cleanEndpoint(endpoint)}`,{method,body},d.credentials);if(control&&(e.status===404||e.status===401||e.status===403)&&!d.credentials)throw err('Deze bediening is door jouw Philips-firmware beveiligd. De huidige HTTP-verbinding blijft actief.',409,'secure_control_required');throw e}}if(d.credentials)return secureJson(`https://${d.ip}:1926/6/${cleanEndpoint(endpoint)}`,{method,body},d.credentials);throw err('Secure credentials ontbreken. De opgeslagen HTTP-verbinding is niet verwijderd.',409,'secure_control_required')}
const KEY_ALIASES={Settings:'Adjust',Menu:'Options',Power:'Standby',PlayPause:'PlayPause'};
async function tvKey(d,key){return tvRequest(d,'input/key',{method:'POST',body:{key:KEY_ALIASES[key]||key},control:true})}
async function tvVolume(d,v){let max=60;const cur=await optional(()=>tvRequest(d,'audio/volume'));if(cur.ok&&Number.isFinite(Number(cur.data.max)))max=Number(cur.data.max);return tvRequest(d,'audio/volume',{method:'POST',body:{muted:false,current:Math.max(0,Math.min(max,Number(v)))},control:true})}
async function tvMute(d,muted){const cur=await optional(()=>tvRequest(d,'audio/volume'));return tvRequest(d,'audio/volume',{method:'POST',body:{muted:Boolean(muted),current:Number(cur.ok?cur.data.current:20)},control:true})}
async function tvStatus(d){const [vol,act,power,ambi,system]=await Promise.all([optional(()=>tvRequest(d,'audio/volume')),optional(()=>tvRequest(d,'activities/current')),optional(()=>tvRequest(d,'powerstate')),optional(()=>tvRequest(d,'ambilight/currentconfiguration')),optional(()=>tvRequest(d,'system'))]);const out={connected:true,apiMode:d.apiMode,apiVersion:d.apiVersion||6,secureCredentials:!!d.credentials};if(vol.ok){out.volume=vol.data.current;out.muted=vol.data.muted;out.maxVolume=vol.data.max}if(act.ok){out.source=act.data.channel?.name||act.data.component?.label||act.data.component?.source||null;out.app=act.data.intent?.component?.packageName||act.data.component?.packageName||null}if(power.ok)out.power=power.data.powerstate||power.data.power||power.data.current;if(ambi.ok){out.ambilight=ambi.data.styleName||ambi.data.style||ambi.data.menuSetting||'On';out.ambilightConfiguration=ambi.data}out.capabilities={volume:vol.ok,activities:act.ok,power:power.ok,ambilight:ambi.ok,inputkey:!!system.data?.featuring?.jsonfeatures?.inputkey,applications:!!system.data?.featuring?.jsonfeatures?.applications,recordings:!!system.data?.featuring?.jsonfeatures?.recordings,textentry:!!system.data?.featuring?.jsonfeatures?.textentry};return out}

async function tvApps(d){const r=await optional(()=>tvRequest(d,'applications'));if(!r.ok)return {apps:[],unavailable:true,reason:r.error,status:r.status,securePossible:!!d.credentials};const list=r.data.applications||r.data.apps||[];return {apps:list.map((a,i)=>({id:a.id||a.intent?.component?.packageName||String(i),name:a.label||a.name||a.intent?.component?.packageName||`App ${i+1}`,raw:a})),unavailable:false}}
async function tvLaunch(d,a){const x=a.raw||a;if(x.intent)return tvRequest(d,'activities/launch',{method:'POST',body:x,control:true});if(x.id)return tvRequest(d,'activities/launch',{method:'POST',body:{intent:{component:{packageName:x.id}}},control:true});throw new Error('No launch intent')}

function hexToRgb(hex){const s=String(hex||'#7c5cff').replace('#','');return {r:parseInt(s.slice(0,2),16)||0,g:parseInt(s.slice(2,4),16)||0,b:parseInt(s.slice(4,6),16)||0}}
function rgbToHsb({r,g,b}){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360}const s=max===0?0:d/max;return {hue:Math.round(h),saturation:Math.round(s*100),brightness:Math.round(max*255)}}
function hsvRgb(h,s=1,v=1){h=((h%360)+360)%360;s=Math.max(0,Math.min(1,s));v=Math.max(0,Math.min(1,v));const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;let r=0,g=0,b=0;if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}return {r:Math.round((r+m)*255),g:Math.round((g+m)*255),b:Math.round((b+m)*255)}}
function pixels(count,rgb){const out={};for(let i=0;i<Number(count||0);i++)out[String(i)]={...rgb};return out}
async function ambilightInfo(d){const [styles,topology,current,power,mode,cached]=await Promise.all([optional(()=>tvRequest(d,'ambilight/supportedstyles')),optional(()=>tvRequest(d,'ambilight/topology')),optional(()=>tvRequest(d,'ambilight/currentconfiguration')),optional(()=>tvRequest(d,'ambilight/power')),optional(()=>tvRequest(d,'ambilight/mode')),optional(()=>tvRequest(d,'ambilight/cached'))]);return {styles:styles.ok?(styles.data.supportedStyles||styles.data.styles||[]):[],topology:topology.ok?topology.data:null,current:current.ok?current.data:null,power:power.ok?power.data:null,mode:mode.ok?mode.data:null,cached:cached.ok?cached.data:null,errors:{styles:styles.ok?null:styles.error,topology:topology.ok?null:topology.error,current:current.ok?null:current.error}}}
function stopAmbiAnimation(deviceId){const s=ambiAnimations.get(deviceId);if(s){s.running=false;if(s.timer)clearTimeout(s.timer);ambiAnimations.delete(deviceId);console.log(`[AMBI] animation stopped for ${deviceId}`)}return {ok:true}}
async function applyAmbilight(d,p){stopAmbiAnimation(d.id);const mode=String(p.mode||'FOLLOW_VIDEO').toUpperCase();if(mode==='OFF'){const a=await optional(()=>tvRequest(d,'ambilight/power',{method:'POST',body:{power:'Off'},control:true}));if(a.ok)return {ok:true,route:'power'};await tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{styleName:'OFF',isExpert:false},control:true});return {ok:true,route:'configuration'}}await optional(()=>tvRequest(d,'ambilight/power',{method:'POST',body:{power:'On'},control:true}));if(mode==='FOLLOW_VIDEO'){const menu=String(p.preset||p.menuSetting||'STANDARD').toUpperCase();await tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{styleName:'FOLLOW_VIDEO',isExpert:false,menuSetting:menu,stringValue:menu.replaceAll('_',' ')},control:true});return {ok:true,mode,menuSetting:menu}}if(mode==='FOLLOW_AUDIO'){const alg=String(p.algorithm||'ENERGY_ADAPTIVE_BRIGHTNESS').toUpperCase(),tuning=Math.max(0,Math.min(2,Number(p.tuning||0)));await tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{styleName:'FOLLOW_AUDIO',isExpert:false,menuSetting:alg,algorithm:alg,tuning},control:true});return {ok:true,mode,algorithm:alg,tuning}}if(mode==='FOLLOW_COLOR'){const menu=String(p.preset||'CUSTOM_COLOR').toUpperCase(),hsb=rgbToHsb(hexToRgb(p.color));const body={styleName:'FOLLOW_COLOR',isExpert:false,menuSetting:menu,stringValue:menu.replaceAll('_',' ')};if(menu==='CUSTOM_COLOR')body.colorSettings={color:{hue:Math.round(hsb.hue*(255/360)),saturation:Math.round(hsb.saturation*(255/100)),brightness:hsb.brightness}};await tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body,control:true});return {ok:true,mode,preset:menu}}if(mode==='FLAG'){const menu=String(p.preset||'NETHERLANDS').toUpperCase();await tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{styleName:'FLAG',isExpert:false,menuSetting:menu,stringValue:menu.replaceAll('_',' ')},control:true});return {ok:true,mode,preset:menu}}await tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{styleName:mode,isExpert:false,menuSetting:String(p.preset||'STANDARD').toUpperCase()},control:true});return {ok:true,mode}}
async function applyZoneColor(d,{color='#7c5cff',zones={left:true,top:true,right:true}}={}){stopAmbiAnimation(d.id);const info=await ambilightInfo(d),topology=info.topology||{};if(!topology||(!topology.left&&!topology.top&&!topology.right))throw err('TV reports no editable Ambilight topology.',400,'no_topology');const rgb=hexToRgb(color),off={r:0,g:0,b:0},layer1={};for(const side of ['left','top','right']){const count=Number(topology[side]||0);if(count>0)layer1[side]=pixels(count,zones[side]===false?off:rgb)}if(Number(topology.bottom||0)>0)layer1.bottom=pixels(Number(topology.bottom),off);await optional(()=>tvRequest(d,'ambilight/power',{method:'POST',body:{power:'On'},control:true}));await tvRequest(d,'ambilight/mode',{method:'POST',body:{current:'manual'},control:true});await tvRequest(d,'ambilight/cached',{method:'POST',body:{layer1},control:true});return {ok:true,mode:'manual',zones,topology}}

function effectRgb(effect,pos,t){
  const wave=(a,b,x)=>a+(b-a)*(0.5-0.5*Math.cos(x*Math.PI*2));
  if(effect==='rainbow')return hsvRgb((t+pos*360)%360,.96,1);
  if(effect==='aurora')return hsvRgb(wave(165,285,t/720+pos*.20),.82,wave(.55,1,t/530+pos*.17));
  if(effect==='ocean')return hsvRgb(wave(182,225,t/900+pos*.13),.9,wave(.48,.95,t/640+pos*.11));
  if(effect==='sunset')return hsvRgb(wave(8,330,t/1200+pos*.16),.86,wave(.68,1,t/720+pos*.12));
  if(effect==='breathe')return hsvRgb(268,.72,wave(.22,1,t/820));
  if(effect==='neon')return hsvRgb(wave(275,330,t/650+pos*.25),.94,wave(.58,1,t/480+pos*.14));
  return hsvRgb((t+pos*360)%360,.9,1)
}
function animationLayer(topology,effect,phase){const sides=['left','top','right'],total=sides.reduce((n,s)=>n+Number(topology[s]||0),0)||1;let cursor=0;const layer1={};for(const side of sides){const count=Number(topology[side]||0);if(!count)continue;const out={};for(let i=0;i<count;i++){const pos=(cursor+i)/total;out[String(i)]=effectRgb(effect,pos,phase)}cursor+=count;layer1[side]=out}if(Number(topology.bottom||0)>0)layer1.bottom=pixels(Number(topology.bottom),{r:0,g:0,b:0});return {layer1}}
async function startAmbiAnimation(d,{effect='rainbow',speed=60}={}){
  stopAmbiAnimation(d.id);
  const info=await ambilightInfo(d),topology=info.topology||{};
  if(!topology.left&&!topology.top&&!topology.right)throw err('TV reports no editable Ambilight topology.',400,'no_topology');
  await optional(()=>tvRequest(d,'ambilight/power',{method:'POST',body:{power:'On'},control:true}));
  await tvRequest(d,'ambilight/mode',{method:'POST',body:{current:'manual'},control:true});
  const session={running:true,effect:String(effect).toLowerCase(),speed:Math.max(1,Math.min(100,Number(speed)||60)),phase:0,frames:0,lastError:null,timer:null,topology,deviceId:d.id};
  ambiAnimations.set(d.id,session);
  const loop=async()=>{
    if(!session.running)return;
    const started=Date.now();
    try{
      await tvRequest(d,'ambilight/cached',{method:'POST',body:animationLayer(topology,session.effect,session.phase),control:true});
      session.frames++;session.phase=(session.phase+(0.7+session.speed*.055))%360;session.lastError=null;
    }catch(e){session.lastError=e.message;session.running=false;ambiAnimations.delete(d.id);console.error(`[AMBI] animation failed: ${e.message}`);return}
    const target=Math.round(165-(session.speed*1.15));
    const delay=Math.max(12,target-(Date.now()-started));
    session.timer=setTimeout(loop,delay);
  };
  loop();
  console.log(`[AMBI] ${session.effect} started for ${d.id} at speed ${session.speed}`);
  return {ok:true,running:true,effect:session.effect,speed:session.speed,topology}
}
function ambiAnimationStatus(d){const s=ambiAnimations.get(d.id);return s?{running:s.running,effect:s.effect,speed:s.speed,frames:s.frames,lastError:s.lastError}:{running:false}}

async function androidInfo(d){const [system,activity,storage,channels,recordings,timestamp]=await Promise.all([optional(()=>tvRequest(d,'system')),optional(()=>tvRequest(d,'activities/current')),optional(()=>tvRequest(d,'storage')),optional(()=>tvRequest(d,'channeldb/tv/channelLists/all')),optional(()=>tvRequest(d,'recordings/list')),optional(()=>tvRequest(d,'timestamp'))]);return {system:system.ok?system.data:null,activity:activity.ok?activity.data:null,storage:storage.ok?storage.data:null,channels:channels.ok?channels.data:null,recordings:recordings.ok?recordings.data:null,timestamp:timestamp.ok?timestamp.data:null,availability:{system:system.ok,activity:activity.ok,storage:storage.ok,channels:channels.ok,recordings:recordings.ok,timestamp:timestamp.ok},errors:{storage:storage.error,channels:channels.error,recordings:recordings.error}}}
function localIPv4s(){const out=[];for(const xs of Object.values(os.networkInterfaces()))for(const i of xs||[])if(i.family==='IPv4'&&!i.internal&&(/^192\.168\./.test(i.address)||/^10\./.test(i.address)||/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)))out.push(i.address);return [...new Set(out)]}
function subnets(){return [...new Set(localIPv4s().map(ip=>ip.split('.').slice(0,3).join('.')))]}
function tcp(host,port,timeout=650){return new Promise(resolve=>{const s=new net.Socket();let done=false;const finish=v=>{if(done)return;done=true;try{s.destroy()}catch{}resolve(v)};s.setTimeout(timeout);s.once('connect',()=>finish(true));s.once('timeout',()=>finish(false));s.once('error',()=>finish(false));s.connect(port,host)})}
async function probe(ip){const [p1925,p1926]=await Promise.all([tcp(ip,1925),tcp(ip,1926)]);if(!p1925&&!p1926)return null;let d={id:`philips:${ip}`,ip,brand:'philips',name:'Philips TV',model:'Smart TV',api:'JointSpace',ports:{jointspace1925:p1925,jointspace1926:p1926}};if(p1925){const h=await tryHttpJointSpace(ip);if(h.ok)d={...d,name:h.data.name||d.name,model:h.data.model||h.data.name||d.model,api:`JointSpace HTTP v${h.apiVersion}`,apiVersion:h.apiVersion}}return d}
async function discover(){const map=new Map();for(const d of Object.values(store.devices||{})){if(d?.ip){const p=await probe(d.ip);if(p)map.set(p.ip,{...d,...p,credentials:undefined})}}const client=new Client();client.on('response',async h=>{try{const loc=h.LOCATION||h.Location,ip=loc?new URL(loc).hostname:null;if(ip&&!map.has(ip)){const d=await probe(ip);if(d)map.set(ip,d)}}catch{}});try{client.search('ssdp:all')}catch{}await wait(2400);try{client.stop()}catch{}for(const subnet of subnets()){const ips=Array.from({length:254},(_,i)=>`${subnet}.${i+1}`);for(let n=0;n<ips.length;n+=24){const found=await Promise.all(ips.slice(n,n+24).map(probe));for(const d of found)if(d)map.set(d.ip,{...(map.get(d.ip)||{}),...d})}}return [...map.values()]}
async function diagnose(ip){const result={ip,tcp1925:await tcp(ip,1925,1200),tcp1926:await tcp(ip,1926,1200),httpV1:null,httpV6:null,httpRoot:null,secureSystem:null};for(const [k,url] of [['httpV1',`http://${ip}:1925/1/system`],['httpV6',`http://${ip}:1925/6/system`],['httpRoot',`http://${ip}:1925/system`]]){try{const r=await httpResponse(url,{timeoutMs:3500});result[k]={ok:r.ok,http:r.status,data:r.ok?r.data:undefined}}catch(e){result[k]={ok:false,error:e.message}}}try{const s=await httpsResponse(`https://${ip}:1926/6/system`,{method:'GET',timeoutMs:4500});result.secureSystem={ok:true,http:s.status,hasDigest:!!s.headers['www-authenticate']}}catch(e){result.secureSystem={ok:false,error:e.message,code:e.code||null}}return result}
function getDeviceFromReq(req){const id=req.body?.deviceId||req.query?.deviceId,d=getSaved(id);if(!d)throw err('Unknown device',404,'unknown_device');return d}
function sendError(res,e){const status=e.status&&e.status>=400&&e.status<600?e.status:400;res.status(status).json({error:e.message,code:e.code||null,details:e.data||null})}

app.get('/api/health',(req,res)=>res.json({ok:true,name:'Smart TV Controller Bridge',version:VERSION,localIPv4s:localIPv4s(),subnets:subnets(),mode:'persistent-http-with-secure-fallback',pairingProtected:true,bridgeAnimations:true}));
app.get('/api/diagnose',async(req,res)=>{try{res.json(await diagnose(String(req.query.ip||'').trim()))}catch(e){sendError(res,e)}});
app.post('/api/discover',async(req,res)=>{try{res.json({devices:await discover()})}catch(e){sendError(res,e)}});
app.post('/api/connect',async(req,res)=>{try{const x=req.body||{};if(!x.ip)throw new Error('Missing TV IP');const id=`philips:${x.ip}`,old=getSaved(id)||{},h=await tryHttpJointSpace(x.ip);if(h.ok){const d=saveDevice({...old,...x,id,brand:'philips',apiMode:'http',apiVersion:h.apiVersion,paired:old.paired||false,name:h.data.name||x.name||old.name||'Philips TV',model:h.data.model||old.model||x.model||'Smart TV',credentials:old.credentials});return res.json({ok:true,device:sanitizeDevice(d),apiMode:'http',apiVersion:h.apiVersion,secureCredentials:!!d.credentials})}if(old.credentials){const d=saveDevice({...old,...x,id,brand:'philips',apiMode:'secure'});return res.json({ok:true,device:sanitizeDevice(d),apiMode:'secure',secureCredentials:true})}res.status(503).json({error:`TV found but JointSpace HTTP system endpoint is unavailable: ${h.error}`,temporary:true,device:sanitizeDevice(old)})}catch(e){sendError(res,e)}});
app.post('/api/pair/request',async(req,res)=>{try{const ip=String(req.body?.ip||'').trim(),h=await tryHttpJointSpace(ip);if(h.ok)return res.status(409).json({error:'HTTP mode is active. Pairing was not started automatically.',pairingProtected:true});res.json(await pairRequest(ip))}catch(e){sendError(res,e)}});
app.post('/api/pair/grant',async(req,res)=>{try{res.json(await pairGrant(String(req.body?.ip||'').trim(),req.body?.pin))}catch(e){sendError(res,e)}});
app.get('/api/status',async(req,res)=>{try{res.json(await tvStatus(getDeviceFromReq(req)))}catch(e){sendError(res,e)}});
app.post('/api/key',async(req,res)=>{try{await tvKey(getDeviceFromReq(req),req.body.key);res.json({ok:true})}catch(e){sendError(res,e)}});
app.post('/api/volume',async(req,res)=>{try{await tvVolume(getDeviceFromReq(req),req.body.volume);res.json({ok:true})}catch(e){sendError(res,e)}});
app.post('/api/mute',async(req,res)=>{try{await tvMute(getDeviceFromReq(req),req.body.muted);res.json({ok:true})}catch(e){sendError(res,e)}});
app.get('/api/apps',async(req,res)=>{try{res.json(await tvApps(getDeviceFromReq(req)))}catch(e){sendError(res,e)}});
app.post('/api/apps/launch',async(req,res)=>{try{await tvLaunch(getDeviceFromReq(req),req.body.app);res.json({ok:true})}catch(e){sendError(res,e)}});
app.get('/api/ambilight/info',async(req,res)=>{try{res.json(await ambilightInfo(getDeviceFromReq(req)))}catch(e){sendError(res,e)}});
app.get('/api/ambilight/styles',async(req,res)=>{try{const i=await ambilightInfo(getDeviceFromReq(req));res.json({styles:i.styles,current:i.current})}catch(e){sendError(res,e)}});
app.get('/api/ambilight/topology',async(req,res)=>{try{const i=await ambilightInfo(getDeviceFromReq(req));res.json(i.topology||{})}catch(e){sendError(res,e)}});
app.post('/api/ambilight',async(req,res)=>{try{res.json(await applyAmbilight(getDeviceFromReq(req),req.body||{}))}catch(e){sendError(res,e)}});
app.post('/api/ambilight/zones',async(req,res)=>{try{res.json(await applyZoneColor(getDeviceFromReq(req),req.body||{}))}catch(e){sendError(res,e)}});
app.post('/api/ambilight/animation/start',async(req,res)=>{try{res.json(await startAmbiAnimation(getDeviceFromReq(req),req.body||{}))}catch(e){sendError(res,e)}});
app.post('/api/ambilight/animation/stop',(req,res)=>{try{const d=getDeviceFromReq(req);res.json(stopAmbiAnimation(d.id))}catch(e){sendError(res,e)}});
app.get('/api/ambilight/animation/status',(req,res)=>{try{res.json(ambiAnimationStatus(getDeviceFromReq(req)))}catch(e){sendError(res,e)}});
app.get('/api/android/info',async(req,res)=>{try{res.json(await androidInfo(getDeviceFromReq(req)))}catch(e){sendError(res,e)}});
app.get('/api/info',async(req,res)=>{try{const d=getDeviceFromReq(req),[system,power,status]=await Promise.all([optional(()=>tvRequest(d,'system')),optional(()=>tvRequest(d,'powerstate')),tvStatus(d)]);res.json({device:sanitizeDevice(d),system:system.ok?system.data:{},power:power.ok?power.data:{},status})}catch(e){sendError(res,e)}});
app.post('/api/text',(req,res)=>res.status(501).json({error:'Text entry is not enabled because firmware support varies.'}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));

const server=app.listen(PORT,'0.0.0.0',()=>{console.log('\n================================================');console.log(` Smart TV Controller Bridge v${VERSION}`);console.log(` Open app:   http://localhost:${PORT}`);console.log(` Health:     http://localhost:${PORT}/api/health`);console.log(` Local IPs:  ${localIPv4s().join(', ')||'none detected'}`);console.log(' Ambilight:  bridge-side cached LED animation engine');console.log(' Pairing:    protected; never auto-started while HTTP mode is alive');console.log('================================================\n')});
server.on('error',e=>{console.error('Bridge could not start:',e.message);process.exitCode=1});