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
const VERSION='0.5.0';
const PAIR_SECRET='ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==';
const pairSessions=new Map();
const pairLocks=new Map();
const routeCache=new Map();

app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Private-Network','true');res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');next()});
app.use(cors({origin:true,methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type']}));
app.options('*',cors());
app.use(express.json({limit:'512kb'}));
app.use(express.static(ROOT,{etag:false,lastModified:false,maxAge:0}));

let store={devices:{}};
try{store=JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{}
function persist(){fs.writeFileSync(STORE,JSON.stringify(store,null,2))}
function getSaved(id){return store.devices[id]||null}
function saveDevice(d){const id=d.id||`${d.brand||'philips'}:${d.ip}`;store.devices[id]={...(store.devices[id]||{}),...d,id};persist();return store.devices[id]}
function parseJson(t){try{return t?JSON.parse(t):{}}catch{return {raw:t}}}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function timeoutSignal(ms){return typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(ms):undefined}

async function httpResponse(url,{method='GET',body,timeoutMs=4500}={}){
  const r=await fetch(url,{method,headers:{Accept:'application/json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:timeoutSignal(timeoutMs)});
  const text=await r.text();
  return {status:r.status,ok:r.ok,data:parseJson(text),headers:Object.fromEntries(r.headers.entries())};
}
async function httpJson(url,opts={}){const r=await httpResponse(url,opts);if(!r.ok){const e=new Error(r.data.error||r.data.message||`HTTP ${r.status}`);e.status=r.status;e.data=r.data;throw e}return r.data}

function httpCandidates(d,endpoint){
  const clean=String(endpoint||'').replace(/^\/+/, '');
  const preferred=Number(d.apiVersion||6);
  const versions=[preferred,...[6,1].filter(v=>v!==preferred)];
  return [...new Set([...versions.map(v=>`http://${d.ip}:1925/${v}/${clean}`),`http://${d.ip}:1925/${clean}`])];
}
function routeKey(d,endpoint,method){return `${d.ip}|${String(method||'GET').toUpperCase()}|${endpoint}`}
async function httpTvRequest(d,endpoint,{method='GET',body}={}){
  const key=routeKey(d,endpoint,method),cached=routeCache.get(key),urls=httpCandidates(d,endpoint),ordered=cached?[cached,...urls.filter(u=>u!==cached)]:urls;
  let lastError=null;
  for(const url of ordered){
    try{
      const r=await httpResponse(url,{method,body,timeoutMs:5000});
      if(r.ok){routeCache.set(key,url);console.log(`[TV] ${method} ${endpoint} -> ${url.replace(`http://${d.ip}:1925`,'')} (${r.status})`);return r.data}
      if(r.status===404){lastError=Object.assign(new Error(`HTTP 404 at ${new URL(url).pathname}`),{status:404});continue}
      const e=new Error(r.data.error||r.data.message||`HTTP ${r.status}`);e.status=r.status;throw e;
    }catch(e){lastError=e;if(e.status===404)continue;throw e}
  }
  throw lastError||new Error(`No working route for ${endpoint}`);
}

async function tryHttpJointSpace(ip){
  const errors=[];
  for(const apiVersion of [6,1]){
    try{const data=await httpJson(`http://${ip}:1925/${apiVersion}/system`,{timeoutMs:3500});console.log(`[HTTP] ${ip} JointSpace /${apiVersion} works on port 1925`);return {ok:true,data,apiVersion}}
    catch(e){errors.push(`/${apiVersion}: ${e.message}`)}
  }
  try{const data=await httpJson(`http://${ip}:1925/system`,{timeoutMs:3500});console.log(`[HTTP] ${ip} unversioned JointSpace works on port 1925`);return {ok:true,data,apiVersion:6,unversioned:true}}
  catch(e){errors.push(`/system: ${e.message}`)}
  return {ok:false,error:errors.join(' | ')};
}

function httpsResponse(url,{method='GET',body,headers={},timeoutMs=7000}={}){return new Promise((resolve,reject)=>{const u=new URL(url),payload=body==null?null:(typeof body==='string'?body:JSON.stringify(body));let done=false;const finish=(fn,v)=>{if(done)return;done=true;fn(v)};const req=https.request({hostname:u.hostname,port:Number(u.port||443),path:u.pathname+u.search,method,rejectUnauthorized:false,timeout:timeoutMs,headers:{Accept:'application/json','User-Agent':`Smart-TV-Controller/${VERSION}`,...(payload!==null?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>finish(resolve,{status:res.statusCode||0,headers:res.headers,data:parseJson(text)}));res.on('error',e=>finish(reject,e))});req.on('timeout',()=>req.destroy(Object.assign(new Error('TV request timed out'),{code:'ETIMEDOUT'})));req.on('error',e=>finish(reject,e));if(payload!==null)req.write(payload);req.end()})}
async function httpsRetry(url,opts,retries=1){let last;for(let i=0;i<=retries;i++){try{return await httpsResponse(url,opts)}catch(e){last=e;if(i===retries)throw e;await wait(250)}}throw last}
function parseDigest(header=''){const src=String(Array.isArray(header)?header[0]:header).replace(/^Digest\s+/i,'');const o={};const re=/(\w+)=(?:"([^"]*)"|([^,\s]+))/g;let m;while((m=re.exec(src)))o[m[1].toLowerCase()]=m[2]??m[3];return o}
function hash(alg,s){const a=String(alg||'MD5').toUpperCase();const n=a.startsWith('SHA-256')?'sha256':a.startsWith('SHA-512-256')?'sha512-256':'md5';return crypto.createHash(n).update(s).digest('hex')}
function digestAuth(url,method,creds,challenge){const c=parseDigest(challenge);if(!c.realm||!c.nonce)throw new Error('Invalid Digest challenge');const u=new URL(url),uri=u.pathname+u.search,alg=c.algorithm||'MD5',cnonce=crypto.randomBytes(8).toString('hex'),nc='00000001',qop=String(c.qop||'').split(',').map(x=>x.trim().replace(/^"|"$/g,'')).find(x=>x==='auth')||'';let ha1=hash(alg,`${creds.username}:${c.realm}:${creds.password}`);if(String(alg).toLowerCase().endsWith('-sess'))ha1=hash(alg,`${ha1}:${c.nonce}:${cnonce}`);const ha2=hash(alg,`${method}:${uri}`);const response=qop?hash(alg,`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`):hash(alg,`${ha1}:${c.nonce}:${ha2}`);const p=[`username="${creds.username}"`,`realm="${c.realm}"`,`nonce="${c.nonce}"`,`uri="${uri}"`,`response="${response}"`];if(c.algorithm)p.push(`algorithm=${c.algorithm}`);if(c.opaque)p.push(`opaque="${c.opaque}"`);if(qop)p.push(`qop=${qop}`,`nc=${nc}`,`cnonce="${cnonce}"`);return `Digest ${p.join(', ')}`}
async function secureJson(url,{method='GET',body}={},creds){const u=new URL(url),challengeUrl=`${u.protocol}//${u.host}/6/system`;const probe=await httpsRetry(challengeUrl,{method:'GET',timeoutMs:6500},1);if(probe.status!==401||!probe.headers['www-authenticate'])throw new Error(`Digest challenge failed (HTTP ${probe.status})`);let auth=digestAuth(url,method,creds,probe.headers['www-authenticate']);let r=await httpsRetry(url,{method,body,headers:{Authorization:auth},timeoutMs:8500},1);if(r.status===401&&r.headers['www-authenticate']){auth=digestAuth(url,method,creds,r.headers['www-authenticate']);r=await httpsRetry(url,{method,body,headers:{Authorization:auth},timeoutMs:8500},1)}if(r.status<200||r.status>=300){const e=new Error(r.data.error_text||r.data.error||r.data.message||`HTTP ${r.status}`);e.status=r.status;throw e}return r.data}

function randomId(){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';let out='';for(let i=0;i<16;i++)out+=chars[crypto.randomInt(chars.length)];return out}
function pairingDevice(id){return {device_name:'Smart TV Controller',device_os:process.platform==='win32'?'Windows':'Desktop',app_name:'Smart TV Controller',type:'native',app_id:'app.id',id}}
function pairingSignature(ts,pin){const key=Buffer.from(PAIR_SECRET,'base64');const hex=crypto.createHmac('sha1',key).update(String(ts)+String(pin)).digest('hex');return Buffer.from(hex).toString('base64')}
function sessionAlive(s){return s&&Date.now()-s.createdAt<Math.max(90000,Number(s.timeout||60)*1000+20000)}
function philipsPairRequestTransport(ip,body){return new Promise((resolve,reject)=>{const payload=JSON.stringify(body);const req=https.request({hostname:ip,port:1926,path:'/6/pair/request',method:'POST',rejectUnauthorized:false,timeout:7000,headers:{Accept:'application/json',Connection:'close','Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,data:parseJson(text)}))});req.on('timeout',()=>req.destroy(Object.assign(new Error('TV request timed out'),{code:'ETIMEDOUT'})));req.on('error',reject);req.write(payload);req.end()})}
async function createPair(ip){const old=pairSessions.get(ip);if(sessionAlive(old))return {ok:true,reused:true,timeout:old.timeout,message:'Er is al een actieve PIN.'};const deviceId=randomId(),body={scope:['read','write','control'],device:pairingDevice(deviceId)};let r;try{r=await philipsPairRequestTransport(ip,body)}catch(e){throw new Error('De Philips TV reageerde niet op de pairing-request.')}if(r.status<200||r.status>=300)throw new Error(r.data.error_text||r.data.error||`HTTP ${r.status}`);if(!r.data.auth_key||r.data.timestamp===undefined)throw new Error('TV returned no pairing credentials');const s={deviceId,authKey:r.data.auth_key,timestamp:r.data.timestamp,createdAt:Date.now(),timeout:r.data.timeout||60};pairSessions.set(ip,s);saveDevice({id:`philips:${ip}`,ip,brand:'philips',apiMode:'secure',pairingPending:true});return {ok:true,timeout:s.timeout,message:'PIN aangevraagd. Kijk op de TV.'}}
async function pairRequest(ip){if(pairLocks.has(ip))return pairLocks.get(ip);const p=createPair(ip).finally(()=>pairLocks.delete(ip));pairLocks.set(ip,p);return p}
async function pairGrant(ip,pin){const s=pairSessions.get(ip);if(!sessionAlive(s))throw new Error('PIN-sessie verlopen. Vraag een nieuwe PIN aan.');const code=String(pin).trim();if(!/^\d{4,8}$/.test(code))throw new Error('Ongeldige PIN.');const creds={username:s.deviceId,password:s.authKey},body={auth:{auth_AppId:'1',pin:code,auth_timestamp:s.timestamp,auth_signature:pairingSignature(s.timestamp,code)},device:pairingDevice(s.deviceId)};const data=await secureJson(`https://${ip}:1926/6/pair/grant`,{method:'POST',body},creds);if(data.error_id&&data.error_id!=='SUCCESS')throw new Error(data.error_text||data.error_id);const d=saveDevice({...(getSaved(`philips:${ip}`)||{}),id:`philips:${ip}`,ip,brand:'philips',apiMode:'secure',credentials:creds,paired:true,pairingPending:false});pairSessions.delete(ip);return {ok:true,device:{...d,credentials:undefined}}}

async function tvRequest(d,endpoint,{method='GET',body}={}){if(d.apiMode==='http')return httpTvRequest(d,endpoint,{method,body});if(d.credentials)return secureJson(`https://${d.ip}:1926/6/${endpoint}`,{method,body},d.credentials);throw new Error('TV is connected without secure credentials; pairing is not required for the current HTTP mode.')}
const KEY_ALIASES={Settings:'Adjust',Menu:'Options',Power:'Standby',Play:'Play',Pause:'Pause'};
async function tvKey(d,key){return tvRequest(d,'input/key',{method:'POST',body:{key:KEY_ALIASES[key]||key}})}
async function optional(d,endpoint,opts){try{return {ok:true,data:await tvRequest(d,endpoint,opts)}}catch(e){return {ok:false,error:e.message,status:e.status||null}}}
async function tvStatus(d){const out={connected:true,apiMode:d.apiMode,apiVersion:d.apiVersion||6};const [vol,act,power,ambi]=await Promise.all([optional(d,'audio/volume'),optional(d,'activities/current'),optional(d,'powerstate'),optional(d,'ambilight/currentconfiguration')]);if(vol.ok){out.volume=vol.data.current;out.muted=vol.data.muted;out.maxVolume=vol.data.max}if(act.ok){out.source=act.data.channel?.name||act.data.component?.label||act.data.component?.source||null;out.app=act.data.intent?.component?.packageName||act.data.component?.packageName||null}if(power.ok)out.power=power.data.powerstate||power.data.power||power.data.current;if(ambi.ok)out.ambilight=ambi.data.styleName||ambi.data.style||ambi.data.menuSetting||'On';out.capabilities={volume:vol.ok,activities:act.ok,power:power.ok,ambilight:ambi.ok};return out}
async function tvVolume(d,v){let max=60;const cur=await optional(d,'audio/volume');if(cur.ok&&Number.isFinite(Number(cur.data.max)))max=Number(cur.data.max);return tvRequest(d,'audio/volume',{method:'POST',body:{muted:false,current:Math.max(0,Math.min(max,Number(v)))}})}
async function tvMute(d,muted){const cur=await optional(d,'audio/volume');return tvRequest(d,'audio/volume',{method:'POST',body:{muted:Boolean(muted),current:Number(cur.ok?cur.data.current:20)}})}
async function tvApps(d){const tries=['applications','applications/'];let last;for(const e of tries){try{const x=await tvRequest(d,e);const list=x.applications||x.apps||[];return list.map((a,i)=>({id:a.id||a.intent?.component?.packageName||String(i),name:a.label||a.name||a.intent?.component?.packageName||`App ${i+1}`,raw:a}))}catch(err){last=err}}throw last}
async function tvLaunch(d,a){const x=a.raw||a;if(x.intent)return tvRequest(d,'activities/launch',{method:'POST',body:x});if(x.id)return tvRequest(d,'activities/launch',{method:'POST',body:{intent:{component:{packageName:x.id}}}});throw new Error('No launch intent')}
async function tvAmbilight(d,p){if(p.mode==='off'){try{return await tvRequest(d,'ambilight/power',{method:'POST',body:{power:'Off'}})}catch{return tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{styleName:'OFF',isExpert:false}})}}try{await tvRequest(d,'ambilight/power',{method:'POST',body:{power:'On'}})}catch{}const style=p.mode==='follow_audio'?'FOLLOW_AUDIO':p.mode==='manual'?'FOLLOW_COLOR':'FOLLOW_VIDEO';const body={styleName:style,isExpert:false,menuSetting:p.menuSetting||'STANDARD'};if(p.mode==='manual'&&p.color){const hex=String(p.color).replace('#','');body.color={r:parseInt(hex.slice(0,2),16),g:parseInt(hex.slice(2,4),16),b:parseInt(hex.slice(4,6),16)}}return tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body})}
async function tvInfo(d){const [system,power,audio,activity,topology,styles]=await Promise.all([optional(d,'system'),optional(d,'powerstate'),optional(d,'audio/volume'),optional(d,'activities/current'),optional(d,'ambilight/topology'),optional(d,'ambilight/supportedstyles')]);return {device:{id:d.id,ip:d.ip,name:d.name,model:d.model,apiMode:d.apiMode,apiVersion:d.apiVersion},system:system.ok?system.data:null,power:power.ok?power.data:null,audio:audio.ok?audio.data:null,activity:activity.ok?activity.data:null,ambilightTopology:topology.ok?topology.data:null,ambilightStyles:styles.ok?styles.data:null}}
async function tvChannels(d){for(const e of ['channeldb/tv/channelLists/all','channels','channelLists']){try{const x=await tvRequest(d,e);const list=x.Channel||x.channels||x.channelLists||x;return Array.isArray(list)?list:[]}catch{}}return []}
async function tvSources(d){try{const x=await tvRequest(d,'sources');return x.sources||x}catch{return []}}

function localIPv4s(){const out=[];for(const xs of Object.values(os.networkInterfaces()))for(const i of xs||[])if(i.family==='IPv4'&&!i.internal&&(/^192\.168\./.test(i.address)||/^10\./.test(i.address)||/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)))out.push(i.address);return [...new Set(out)]}
function subnets(){return [...new Set(localIPv4s().map(ip=>ip.split('.').slice(0,3).join('.')))]}
function tcp(host,port,timeout=650){return new Promise(resolve=>{const s=new net.Socket();let done=false;const finish=v=>{if(done)return;done=true;try{s.destroy()}catch{}resolve(v)};s.setTimeout(timeout);s.once('connect',()=>finish(true));s.once('timeout',()=>finish(false));s.once('error',()=>finish(false));s.connect(port,host)})}
async function probe(ip){const [p1925,p1926]=await Promise.all([tcp(ip,1925),tcp(ip,1926)]);if(!p1925&&!p1926)return null;let d={id:`philips:${ip}`,ip,brand:'philips',name:'Philips TV',model:'Smart TV',api:p1926?'JointSpace v6':'JointSpace',ports:{jointspace1925:p1925,jointspace1926:p1926}};if(p1925){const h=await tryHttpJointSpace(ip);if(h.ok)d={...d,name:h.data.name||d.name,model:h.data.model||d.model,api:`JointSpace HTTP v${h.apiVersion}`,httpApiVersion:h.apiVersion}}return d}
async function discover(){const map=new Map();for(const d of Object.values(store.devices||{})){if(d.ip){const p=await probe(d.ip);if(p)map.set(p.ip,{...d,...p})}}const client=new Client();client.on('response',async h=>{try{const loc=h.LOCATION||h.Location,ip=loc?new URL(loc).hostname:null;if(ip&&!map.has(ip)){const d=await probe(ip);if(d)map.set(ip,d)}}catch{}});try{client.search('ssdp:all')}catch{}await wait(2500);try{client.stop()}catch{}for(const subnet of subnets()){const ips=Array.from({length:254},(_,i)=>`${subnet}.${i+1}`);for(let n=0;n<ips.length;n+=24){const found=await Promise.all(ips.slice(n,n+24).map(probe));for(const d of found)if(d)map.set(d.ip,{...(map.get(d.ip)||{}),...d})}}return [...map.values()]}

async function diagnose(ip){const d={id:`philips:${ip}`,ip,apiMode:'http',apiVersion:6};const result={ip,tcp1925:await tcp(ip,1925,1200),tcp1926:await tcp(ip,1926,1200),routes:{}};for(const ep of ['system','input/key','audio/volume','powerstate','activities/current','applications','ambilight/currentconfiguration']){const urls=httpCandidates(d,ep);result.routes[ep]=[];for(const url of urls){try{const r=await httpResponse(url,{method:'GET',timeoutMs:2200});result.routes[ep].push({path:new URL(url).pathname,status:r.status})}catch(e){result.routes[ep].push({path:new URL(url).pathname,error:e.message})}}}return result}

function withDevice(req){const id=req.body?.deviceId||req.query?.deviceId;const d=getSaved(id);if(!d)throw new Error('Unknown device');return d}
app.get('/api/health',(req,res)=>res.json({ok:true,name:'Smart TV Controller Bridge',version:VERSION,localIPv4s:localIPv4s(),subnets:subnets(),mode:'persistent-http-route-fallback',pairingProtected:true}));
app.get('/api/diagnose',async(req,res)=>{try{res.json(await diagnose(String(req.query.ip||'').trim()))}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/discover',async(req,res)=>{try{res.json({devices:await discover()})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/connect',async(req,res)=>{try{const x=req.body||{};if(!x.ip)throw new Error('Missing TV IP');const saved=getSaved(`philips:${x.ip}`)||{};const h=await tryHttpJointSpace(x.ip);if(h.ok){const d=saveDevice({...saved,...x,id:`philips:${x.ip}`,brand:'philips',apiMode:'http',apiVersion:h.apiVersion,paired:true,pairingPending:false,name:h.data.name||x.name||saved.name||'Philips TV',model:h.data.model||x.model||saved.model||'Smart TV'});console.log(`[CONNECT] ${x.ip} persistent HTTP mode /${h.apiVersion}; pairing untouched`);return res.json({ok:true,device:{...d,credentials:undefined},apiMode:'http',apiVersion:h.apiVersion,pairingProtected:true})}const d=saveDevice({...saved,...x,id:`philips:${x.ip}`,brand:'philips',apiMode:saved.credentials?'secure':'http'});if(d.credentials)return res.json({ok:true,device:{...d,credentials:undefined},apiMode:'secure',pairingProtected:true});res.status(503).json({error:'TV API is temporarily unavailable. Existing connection data was kept; no new PIN was requested.',temporary:true,device:{...d,credentials:undefined}})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/pair/request',async(req,res)=>{try{const ip=String(req.body?.ip||'').trim();const saved=getSaved(`philips:${ip}`);if(saved?.paired&&saved?.apiMode==='http')return res.json({ok:true,skipPin:true,device:{...saved,credentials:undefined},message:'TV is already connected in HTTP mode. Pairing was not touched.'});const h=await tryHttpJointSpace(ip);if(h.ok){const d=saveDevice({...saved,id:`philips:${ip}`,ip,brand:'philips',apiMode:'http',apiVersion:h.apiVersion,paired:true,pairingPending:false,name:h.data.name||saved?.name||'Philips TV',model:h.data.model||saved?.model||'Smart TV'});return res.json({ok:true,skipPin:true,device:{...d,credentials:undefined},message:'PIN niet nodig: bestaande HTTP-verbinding gebruikt.'})}res.json(await pairRequest(ip))}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/pair/grant',async(req,res)=>{try{res.json(await pairGrant(String(req.body?.ip||'').trim(),req.body?.pin))}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/status',async(req,res)=>{try{res.json(await tvStatus(withDevice(req)))}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/info',async(req,res)=>{try{res.json(await tvInfo(withDevice(req)))}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/key',async(req,res)=>{try{await tvKey(withDevice(req),req.body.key);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/volume',async(req,res)=>{try{await tvVolume(withDevice(req),req.body.volume);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/mute',async(req,res)=>{try{await tvMute(withDevice(req),req.body.muted);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/apps',async(req,res)=>{try{res.json({apps:await tvApps(withDevice(req))})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/apps/launch',async(req,res)=>{try{await tvLaunch(withDevice(req),req.body.app);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/channels',async(req,res)=>{try{res.json({channels:await tvChannels(withDevice(req))})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/sources',async(req,res)=>{try{res.json({sources:await tvSources(withDevice(req))})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/ambilight/styles',async(req,res)=>{try{const x=await optional(withDevice(req),'ambilight/supportedstyles');res.json({styles:x.ok?(x.data.supportedStyles||[]):[]})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/ambilight/topology',async(req,res)=>{try{const x=await optional(withDevice(req),'ambilight/topology');res.json(x.ok?x.data:{})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/ambilight',async(req,res)=>{try{await tvAmbilight(withDevice(req),req.body);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/text',(req,res)=>res.status(501).json({error:'Direct text entry is not supported by this Philips JointSpace mode.'}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));

const server=app.listen(PORT,'0.0.0.0',()=>{console.log('\n================================================');console.log(` Smart TV Controller Bridge v${VERSION}`);console.log(` Open app:   http://localhost:${PORT}`);console.log(` Health:     http://localhost:${PORT}/api/health`);console.log(` Local IPs:  ${localIPv4s().join(', ')||'none detected'}`);console.log(` Scan nets:  ${subnets().map(x=>x+'.0/24').join(', ')||'none detected'}`);console.log(' Mode:       persistent connection + automatic /6 -> root -> /1 fallback');console.log(' Pairing:    PROTECTED; existing HTTP connection is never replaced by PIN flow');console.log('================================================\n')});
server.on('error',e=>{console.error('Bridge could not start:',e.message);process.exitCode=1});