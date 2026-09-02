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
const VERSION='0.4.2';
const PAIR_SECRET='ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==';
const pairSessions=new Map();
const pairLocks=new Map();

app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Private-Network','true');res.setHeader('Cache-Control','no-store');next()});
app.use(cors({origin:true,methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type']}));
app.options('*',cors());
app.use(express.json({limit:'256kb'}));
app.use(express.static(ROOT,{etag:false,lastModified:false,maxAge:0}));

let store={devices:{}};
try{store=JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{}
function persist(){fs.writeFileSync(STORE,JSON.stringify(store,null,2))}
function getSaved(id){return store.devices[id]||null}
function saveDevice(d){const id=d.id||`${d.brand||'philips'}:${d.ip}`;store.devices[id]={...(store.devices[id]||{}),...d,id};persist();return store.devices[id]}
function parseJson(t){try{return t?JSON.parse(t):{}}catch{return {raw:t}}}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function timeoutSignal(ms){return AbortSignal.timeout?AbortSignal.timeout(ms):undefined}

async function httpJson(url,{method='GET',body,timeoutMs=4000}={}){
  const r=await fetch(url,{method,headers:{Accept:'application/json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:timeoutSignal(timeoutMs)});
  const text=await r.text();const data=parseJson(text);
  if(!r.ok)throw new Error(data.error||data.message||`HTTP ${r.status}`);
  return data;
}
async function tryLegacySystem(ip){try{return {ok:true,data:await httpJson(`http://${ip}:1925/1/system`,{timeoutMs:3500})}}catch(e){return {ok:false,error:e.message}}}

function httpsResponse(url,{method='GET',body,headers={},timeoutMs=7000}={}){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);const payload=body==null?null:(typeof body==='string'?body:JSON.stringify(body));let done=false;
    const finish=(fn,v)=>{if(done)return;done=true;fn(v)};
    const req=https.request({hostname:u.hostname,port:Number(u.port||443),path:u.pathname+u.search,method,rejectUnauthorized:false,agent:false,timeout:timeoutMs,headers:{Accept:'application/json','User-Agent':`Smart-TV-Controller/${VERSION}`,...(payload!==null?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{'Content-Length':'0'}),...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>finish(resolve,{status:res.statusCode||0,headers:res.headers,data:parseJson(text)}));res.on('error',e=>finish(reject,e));
    });
    req.on('timeout',()=>req.destroy(Object.assign(new Error('TV request timed out'),{code:'ETIMEDOUT'})));req.on('error',e=>finish(reject,e));if(payload!==null)req.write(payload);req.end();
  });
}
async function httpsRetry(url,opts,retries=1){let last;for(let i=0;i<=retries;i++){try{return await httpsResponse(url,opts)}catch(e){last=e;if(i===retries)throw e;await wait(250)}}throw last}
function parseDigest(header=''){const src=String(Array.isArray(header)?header[0]:header).replace(/^Digest\s+/i,'');const o={};const re=/(\w+)=(?:"([^"]*)"|([^,\s]+))/g;let m;while((m=re.exec(src)))o[m[1].toLowerCase()]=m[2]??m[3];return o}
function hash(alg,s){const a=String(alg||'MD5').toUpperCase();const n=a.startsWith('SHA-256')?'sha256':a.startsWith('SHA-512-256')?'sha512-256':'md5';return crypto.createHash(n).update(s).digest('hex')}
function digestAuth(url,method,creds,challenge){const c=parseDigest(challenge);if(!c.realm||!c.nonce)throw new Error('Invalid Digest challenge');const u=new URL(url),uri=u.pathname+u.search,alg=c.algorithm||'MD5',cnonce=crypto.randomBytes(8).toString('hex'),nc='00000001',qop=String(c.qop||'').split(',').map(x=>x.trim().replace(/^"|"$/g,'')).find(x=>x==='auth')||'';let ha1=hash(alg,`${creds.username}:${c.realm}:${creds.password}`);if(String(alg).toLowerCase().endsWith('-sess'))ha1=hash(alg,`${ha1}:${c.nonce}:${cnonce}`);const ha2=hash(alg,`${method}:${uri}`);const response=qop?hash(alg,`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`):hash(alg,`${ha1}:${c.nonce}:${ha2}`);const p=[`username="${creds.username}"`,`realm="${c.realm}"`,`nonce="${c.nonce}"`,`uri="${uri}"`,`response="${response}"`];if(c.algorithm)p.push(`algorithm=${c.algorithm}`);if(c.opaque)p.push(`opaque="${c.opaque}"`);if(qop)p.push(`qop=${qop}`,`nc=${nc}`,`cnonce="${cnonce}"`);return `Digest ${p.join(', ')}`}
async function secureJson(url,{method='GET',body}={},creds){const u=new URL(url),challengeUrl=`${u.protocol}//${u.host}/6/system`;const probe=await httpsRetry(challengeUrl,{method:'GET',timeoutMs:6000},1);if(probe.status!==401||!probe.headers['www-authenticate'])throw new Error(`Digest challenge failed (HTTP ${probe.status})`);let auth=digestAuth(url,method,creds,probe.headers['www-authenticate']);let r=await httpsRetry(url,{method,body,headers:{Authorization:auth},timeoutMs:8000},1);if(r.status===401&&r.headers['www-authenticate']){auth=digestAuth(url,method,creds,r.headers['www-authenticate']);r=await httpsRetry(url,{method,body,headers:{Authorization:auth},timeoutMs:8000},1)}if(r.status<200||r.status>=300)throw new Error(r.data.error_text||r.data.error||r.data.message||`HTTP ${r.status}`);return r.data}

function randomId(){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';let out='';for(let i=0;i<16;i++)out+=chars[crypto.randomInt(chars.length)];return out}
function pairingDevice(id){return {device_name:'Smart TV Controller',device_os:'Android',app_name:'Smart TV Controller',type:'native',app_id:'app.id',id}}
function pairingSignature(ts,pin){const key=Buffer.from(PAIR_SECRET,'base64');const hex=crypto.createHmac('sha1',key).update(String(ts)+String(pin)).digest('hex');return Buffer.from(hex).toString('base64')}
function sessionAlive(s){return s&&Date.now()-s.createdAt<Math.max(90000,Number(s.timeout||60)*1000+20000)}
async function createPair(ip){const old=pairSessions.get(ip);if(sessionAlive(old))return {ok:true,reused:true,timeout:old.timeout,message:'Er is al een actieve PIN.'};const deviceId=randomId(),body={scope:['read','write','control'],device:pairingDevice(deviceId)};console.log(`[PAIR] Sending ONE pairing request to ${ip}...`);let r;try{r=await httpsResponse(`https://${ip}:1926/6/pair/request`,{method:'POST',body,timeoutMs:6000})}catch(e){console.error(`[PAIR] Request transport failure for ${ip}: ${e.code||''} ${e.message}`);throw new Error('De Philips TV reageerde niet binnen 6 seconden op /6/pair/request.')}if(r.status<200||r.status>=300)throw new Error(r.data.error_text||r.data.error||`HTTP ${r.status}`);if(!r.data.auth_key||r.data.timestamp===undefined)throw new Error('TV returned no pairing credentials');const s={deviceId,authKey:r.data.auth_key,timestamp:r.data.timestamp,createdAt:Date.now(),timeout:r.data.timeout||60};pairSessions.set(ip,s);saveDevice({id:`philips:${ip}`,ip,brand:'philips',apiMode:'secure',pairingPending:true});console.log(`[PAIR] PIN requested from ${ip}; device id ${deviceId}`);return {ok:true,timeout:s.timeout,message:'PIN aangevraagd. Kijk op de TV.'}}
async function pairRequest(ip){if(pairLocks.has(ip))return pairLocks.get(ip);const p=createPair(ip).finally(()=>pairLocks.delete(ip));pairLocks.set(ip,p);return p}
async function pairGrant(ip,pin){const s=pairSessions.get(ip);if(!sessionAlive(s))throw new Error('PIN-sessie verlopen. Vraag een nieuwe PIN aan.');const code=String(pin).trim();if(!/^\d{4,8}$/.test(code))throw new Error('Ongeldige PIN.');const creds={username:s.deviceId,password:s.authKey},body={auth:{auth_AppId:'1',pin:code,auth_timestamp:s.timestamp,auth_signature:pairingSignature(s.timestamp,code)},device:pairingDevice(s.deviceId)};const data=await secureJson(`https://${ip}:1926/6/pair/grant`,{method:'POST',body},creds);if(data.error_id&&data.error_id!=='SUCCESS')throw new Error(data.error_text||data.error_id);const d=saveDevice({...(getSaved(`philips:${ip}`)||{}),id:`philips:${ip}`,ip,brand:'philips',apiMode:'secure',credentials:creds,paired:true,pairingPending:false});pairSessions.delete(ip);return {ok:true,device:{...d,credentials:undefined}}}

function base(d){return d.apiMode==='legacy'?`http://${d.ip}:1925/1/`:`https://${d.ip}:1926/6/`}
async function tvRequest(d,endpoint,{method='GET',body}={}){if(d.apiMode==='legacy')return httpJson(base(d)+endpoint,{method,body});if(d.credentials)return secureJson(base(d)+endpoint,{method,body},d.credentials);throw new Error('PIN pairing required')}
const KEYS={Settings:'Adjust'};
async function tvKey(d,key){return tvRequest(d,'input/key',{method:'POST',body:{key:KEYS[key]||key}})}
async function tvStatus(d){const out={};try{const a=await tvRequest(d,'audio/volume');out.volume=a.current;out.muted=a.muted}catch{}try{const c=await tvRequest(d,'activities/current');out.source=c.channel?.name||c.component?.label||c.component?.source||null}catch{}try{const x=await tvRequest(d,'ambilight/currentconfiguration');out.ambilight=x.style||x.menuSetting||'On'}catch{}return out}
async function tvVolume(d,v){let cur={};try{cur=await tvRequest(d,'audio/volume')}catch{}return tvRequest(d,'audio/volume',{method:'POST',body:{muted:false,current:Math.max(0,Math.min(Number(cur.max||60),Number(v)))}})}
async function tvApps(d){const x=await tvRequest(d,'applications');return (x.applications||x.apps||[]).map((a,i)=>({id:a.id||a.intent?.component?.packageName||String(i),name:a.label||a.name||`App ${i+1}`,raw:a}))}
async function tvLaunch(d,a){const x=a.raw||a;if(x.intent)return tvRequest(d,'activities/launch',{method:'POST',body:x});if(x.id)return tvRequest(d,'activities/launch',{method:'POST',body:{intent:{component:{packageName:x.id}}}});throw new Error('No launch intent')}
async function tvAmbilight(d,p){if(p.mode==='off')return tvRequest(d,'ambilight/power',{method:'POST',body:{power:'Off'}});try{await tvRequest(d,'ambilight/power',{method:'POST',body:{power:'On'}})}catch{}return tvRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{style:p.mode==='follow_audio'?'FOLLOW_AUDIO':'FOLLOW_VIDEO'}})}

function localIPv4s(){const out=[];for(const xs of Object.values(os.networkInterfaces()))for(const i of xs||[])if(i.family==='IPv4'&&!i.internal&&(/^192\.168\./.test(i.address)||/^10\./.test(i.address)||/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)))out.push(i.address);return [...new Set(out)]}
function subnets(){return [...new Set(localIPv4s().map(ip=>ip.split('.').slice(0,3).join('.')))]}
function tcp(host,port,timeout=320){return new Promise(resolve=>{const s=new net.Socket();let done=false;const finish=v=>{if(done)return;done=true;try{s.destroy()}catch{}resolve(v)};s.setTimeout(timeout);s.once('connect',()=>finish(true));s.once('timeout',()=>finish(false));s.once('error',()=>finish(false));s.connect(port,host)})}
async function probe(ip){const [p1925,p1926]=await Promise.all([tcp(ip,1925),tcp(ip,1926)]);if(!p1925&&!p1926)return null;let d={id:`philips:${ip}`,ip,brand:'philips',name:'Philips TV',model:'Smart TV',api:p1926?'JointSpace v6':'JointSpace',ports:{jointspace1925:p1925,jointspace1926:p1926}};if(p1925){const l=await tryLegacySystem(ip);if(l.ok)d={...d,name:l.data.name||d.name,model:l.data.model||d.model,api:'JointSpace v1'}}return d}
async function discover(){const map=new Map();const client=new Client();client.on('response',async h=>{try{const loc=h.LOCATION||h.Location,ip=loc?new URL(loc).hostname:null;if(ip&&!map.has(ip)){const d=await probe(ip);if(d)map.set(ip,d)}}catch{}});try{client.search('ssdp:all')}catch{}await wait(1800);try{client.stop()}catch{}for(const subnet of subnets()){const ips=Array.from({length:254},(_,i)=>`${subnet}.${i+1}`);for(let n=0;n<ips.length;n+=32){const found=await Promise.all(ips.slice(n,n+32).map(probe));for(const d of found)if(d)map.set(d.ip,{...(map.get(d.ip)||{}),...d})}}return [...map.values()]}

app.get('/api/health',(req,res)=>res.json({ok:true,name:'Smart TV Controller Bridge',version:VERSION,localIPv4s:localIPv4s(),subnets:subnets(),mode:'legacy-first'}));
app.post('/api/discover',async(req,res)=>{try{res.json({devices:await discover()})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/connect',async(req,res)=>{try{const x=req.body||{};if(!x.ip)throw new Error('Missing TV IP');const l=await tryLegacySystem(x.ip);if(l.ok){const d=saveDevice({...x,id:`philips:${x.ip}`,brand:'philips',apiMode:'legacy',paired:true,name:l.data.name||x.name||'Philips TV',model:l.data.model||x.model||'Smart TV'});console.log(`[CONNECT] ${x.ip} using legacy JointSpace /1 on port 1925`);return res.json({ok:true,device:d,apiMode:'legacy'})}const d=saveDevice({...x,id:`philips:${x.ip}`,brand:'philips',apiMode:'secure'});if(d.credentials)return res.json({ok:true,device:{...d,credentials:undefined},apiMode:'secure'});res.status(401).json({error:'TV requires secure PIN pairing.',needsPairing:true,needsCredentials:true,device:{...d,credentials:undefined}})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/pair/request',async(req,res)=>{try{const ip=String(req.body?.ip||'').trim();const l=await tryLegacySystem(ip);if(l.ok){const d=saveDevice({id:`philips:${ip}`,ip,brand:'philips',apiMode:'legacy',paired:true,name:l.data.name||'Philips TV',model:l.data.model||'Smart TV'});console.log(`[PAIR] Skipped PIN: legacy JointSpace works on ${ip}`);return res.json({ok:true,skipPin:true,device:d,message:'PIN niet nodig: poort 1925 werkt.'})}res.json(await pairRequest(ip))}catch(e){console.error('Pair request error:',e);res.status(400).json({error:e.message})}});
app.post('/api/pair/grant',async(req,res)=>{try{res.json(await pairGrant(String(req.body?.ip||'').trim(),req.body?.pin))}catch(e){console.error('Pair grant error:',e);res.status(400).json({error:e.message})}});
app.get('/api/status',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');res.json(await tvStatus(d))}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/key',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await tvKey(d,req.body.key);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/volume',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await tvVolume(d,req.body.volume);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/apps',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');res.json({apps:await tvApps(d)})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/apps/launch',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await tvLaunch(d,req.body.app);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/ambilight',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await tvAmbilight(d,req.body);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/text',(req,res)=>res.status(501).json({error:'Text entry is not enabled yet.'}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));

const server=app.listen(PORT,'0.0.0.0',()=>{console.log('\n================================================');console.log(` Smart TV Controller Bridge v${VERSION}`);console.log(` Open app:   http://localhost:${PORT}`);console.log(` Health:     http://localhost:${PORT}/api/health`);console.log(` Local IPs:  ${localIPv4s().join(', ')||'none detected'}`);console.log(` Scan nets:  ${subnets().map(x=>x+'.0/24').join(', ')||'none detected'}`);console.log(' Mode:       legacy 1925 first -> secure 1926 fallback');console.log('================================================\n')});
server.on('error',e=>{console.error('Bridge could not start:',e.message);process.exitCode=1});
