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
const VERSION='0.4.0';
const PAIR_SECRET='ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==';

const pairSessions=new Map();
const pairRequestLocks=new Map();

app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Private-Network','true');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
  next();
});
app.use(cors({origin:true,credentials:false,methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type']}));
app.options('*',cors());
app.use(express.json({limit:'256kb'}));
app.use(express.static(ROOT,{etag:false,lastModified:false,maxAge:0}));

let store={devices:{}};
try{store=JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{}
function persist(){fs.writeFileSync(STORE,JSON.stringify(store,null,2))}
function idFor(d){return d.id||`${String(d.brand||'generic').toLowerCase()}:${d.ip}`}
function getSaved(id){return store.devices[id]||null}
function saveDevice(d){const id=idFor(d);store.devices[id]={...(store.devices[id]||{}),...d,id};persist();return store.devices[id]}
function parseJson(text){try{return text?JSON.parse(text):{}}catch{return {raw:text}}}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function timeoutSignal(ms){return typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(ms):undefined}
function retryableNetworkError(e){return !!e&&(/socket hang up|ECONNRESET|EPIPE|timed out|closed the response/i.test(e.message||'')||['ECONNRESET','EPIPE','ETIMEDOUT'].includes(e.code))}

function httpsResponse(url,{method='GET',body,headers={},timeoutMs=7000}={}){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const payload=body===undefined||body===null?null:(typeof body==='string'?body:JSON.stringify(body));
    let settled=false;
    const done=(fn,value)=>{if(settled)return;settled=true;fn(value)};
    const req=https.request({
      hostname:u.hostname,
      port:Number(u.port||443),
      path:u.pathname+u.search,
      method,
      rejectUnauthorized:false,
      agent:false,
      timeout:timeoutMs,
      headers:{
        Accept:'application/json',
        'User-Agent':`Smart-TV-Controller/${VERSION}`,
        Connection:'close',
        ...(payload!==null?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{'Content-Length':'0'}),
        ...headers
      }
    },res=>{
      let text='';
      res.setEncoding('utf8');
      res.on('data',chunk=>text+=chunk);
      res.on('end',()=>done(resolve,{status:res.statusCode||0,headers:res.headers,text,data:parseJson(text)}));
      res.on('aborted',()=>{const e=new Error('TV closed the response early');e.code='ECONNRESET';done(reject,e)});
      res.on('error',e=>done(reject,e));
    });
    req.on('timeout',()=>req.destroy(Object.assign(new Error('TV request timed out'),{code:'ETIMEDOUT'})));
    req.on('error',e=>done(reject,e));
    if(payload!==null)req.write(payload);
    req.end();
  });
}

async function httpsResponseRetry(url,opts={},retries=1){
  let last;
  for(let i=0;i<=retries;i++){
    try{return await httpsResponse(url,opts)}catch(e){
      last=e;
      if(i===retries||!retryableNetworkError(e))throw e;
      await wait(250+i*300);
    }
  }
  throw last;
}

async function httpsJson(url,opts={}){
  const r=await httpsResponseRetry(url,opts,opts.retries??1);
  if(r.status<200||r.status>=300){
    const e=new Error(r.data.error_text||r.data.error||r.data.message||`TV returned HTTP ${r.status}`);
    e.status=r.status;e.data=r.data;e.headers=r.headers;throw e;
  }
  return r.data;
}

function parseDigestChallenge(header=''){
  const raw=Array.isArray(header)?(header.find(v=>/^Digest/i.test(v))||header[0]||''):String(header||'');
  const source=raw.replace(/^Digest\s+/i,'');
  const out={};
  const re=/(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;while((m=re.exec(source)))out[m[1].toLowerCase()]=m[2]!==undefined?m[2]:m[3];
  return out;
}
function digestHash(algorithm,value){
  const a=String(algorithm||'MD5').toUpperCase();
  const nodeAlg=a.startsWith('SHA-256')?'sha256':a.startsWith('SHA-512-256')?'sha512-256':'md5';
  return crypto.createHash(nodeAlg).update(value).digest('hex');
}
function buildDigestAuthorization(url,method,credentials,challenge){
  const c=parseDigestChallenge(challenge);
  if(!c.realm||!c.nonce)throw new Error('Invalid Digest challenge from TV');
  const u=new URL(url);
  const uri=u.pathname+u.search;
  const algorithm=c.algorithm||'MD5';
  const cnonce=crypto.randomBytes(8).toString('hex');
  const nc='00000001';
  const qop=String(c.qop||'').split(',').map(x=>x.trim().replace(/^"|"$/g,'')).find(x=>x==='auth')||'';
  let ha1=digestHash(algorithm,`${credentials.username}:${c.realm}:${credentials.password}`);
  if(String(algorithm).toLowerCase().endsWith('-sess'))ha1=digestHash(algorithm,`${ha1}:${c.nonce}:${cnonce}`);
  const ha2=digestHash(algorithm,`${method}:${uri}`);
  const response=qop?digestHash(algorithm,`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`):digestHash(algorithm,`${ha1}:${c.nonce}:${ha2}`);
  const parts=[`username="${credentials.username}"`,`realm="${c.realm}"`,`nonce="${c.nonce}"`,`uri="${uri}"`,`response="${response}"`];
  if(c.algorithm)parts.push(`algorithm=${c.algorithm}`);
  if(c.opaque)parts.push(`opaque="${c.opaque}"`);
  if(qop)parts.push(`qop=${qop}`,`nc=${nc}`,`cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

async function authenticatedPhilipsJson(url,{method='GET',body,headers={}}={},credentials){
  const u=new URL(url);
  const challengeUrl=`${u.protocol}//${u.host}/6/system`;
  const challengeResponse=await httpsResponseRetry(challengeUrl,{method:'GET',timeoutMs:6000},1);
  if(challengeResponse.status!==401||!challengeResponse.headers['www-authenticate']){
    throw new Error(`Could not get Philips Digest challenge (HTTP ${challengeResponse.status})`);
  }
  let authorization=buildDigestAuthorization(url,String(method).toUpperCase(),credentials,challengeResponse.headers['www-authenticate']);
  let r=await httpsResponseRetry(url,{method,body,headers:{...headers,Authorization:authorization},timeoutMs:8000},1);
  if(r.status===401&&r.headers['www-authenticate']){
    authorization=buildDigestAuthorization(url,String(method).toUpperCase(),credentials,r.headers['www-authenticate']);
    await wait(180);
    r=await httpsResponseRetry(url,{method,body,headers:{...headers,Authorization:authorization},timeoutMs:8000},1);
  }
  if(r.status<200||r.status>=300)throw new Error(r.data.error_text||r.data.error||r.data.message||`TV returned HTTP ${r.status}`);
  return r.data;
}

function randomDeviceId(){
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out='';for(let i=0;i<16;i++)out+=chars[crypto.randomInt(0,chars.length)];return out;
}
function pairingDevice(deviceId){
  return {device_name:'Smart TV Controller',device_os:'Android',app_name:'Smart TV Controller',type:'native',app_id:'app.id',id:deviceId};
}
function pairingSignature(timestamp,pin){
  const key=Buffer.from(PAIR_SECRET,'base64');
  const hex=crypto.createHmac('sha1',key).update(String(timestamp)+String(pin)).digest('hex');
  return Buffer.from(hex,'utf8').toString('base64');
}
function sessionAlive(state){
  if(!state)return false;
  const ttl=Math.max(90000,Number(state.timeout||60)*1000+20000);
  return Date.now()-state.createdAt<ttl;
}

async function createPairSession(ip){
  const existing=pairSessions.get(ip);
  if(sessionAlive(existing)){
    console.log(`[PAIR] Reusing active PIN session for ${ip}`);
    return {ok:true,ip,timeout:existing.timeout||60,reused:true,message:'Er is al een actieve PIN. Gebruik de code die op de TV staat.'};
  }
  pairSessions.delete(ip);

  const deviceId=randomDeviceId();
  const body={scope:['read','write','control'],device:pairingDevice(deviceId)};
  console.log(`[PAIR] Sending ONE pairing request to ${ip}...`);

  let r;
  try{
    r=await httpsResponse(`https://${ip}:1926/6/pair/request`,{method:'POST',body,timeoutMs:6000});
  }catch(e){
    console.error(`[PAIR] Request transport failure for ${ip}: ${e.code||''} ${e.message}`);
    throw new Error(e.code==='ETIMEDOUT'?'De Philips TV reageerde niet binnen 6 seconden op /6/pair/request. Er worden geen achtergrond-retries meer uitgevoerd.':e.message);
  }

  if(r.status<200||r.status>=300)throw new Error(r.data.error_text||r.data.error||r.data.message||`Pair request failed (HTTP ${r.status})`);
  const response=r.data;
  if(response.error_id&&response.error_id!=='SUCCESS')throw new Error(response.error_text||response.error_id);
  if(!response.auth_key||response.timestamp===undefined)throw new Error('TV returned no pairing credentials');

  const state={ip,deviceId,authKey:response.auth_key,timestamp:response.timestamp,createdAt:Date.now(),timeout:response.timeout||60};
  pairSessions.set(ip,state);
  saveDevice({id:`philips:${ip}`,ip,brand:'philips',name:'Philips TV',pairingPending:true});
  console.log(`[PAIR] PIN requested from ${ip}; device id ${deviceId}`);
  return {ok:true,ip,timeout:state.timeout,reused:false,message:'PIN aangevraagd. Kijk nu op de TV.'};
}

async function philipsPairRequest(ip){
  const active=pairRequestLocks.get(ip);
  if(active){
    console.log(`[PAIR] Duplicate browser request ignored for ${ip}; joining active request`);
    return active;
  }
  const promise=createPairSession(ip).finally(()=>pairRequestLocks.delete(ip));
  pairRequestLocks.set(ip,promise);
  return promise;
}

async function philipsPairGrant(ip,pin){
  const state=pairSessions.get(ip);
  if(!sessionAlive(state)){
    pairSessions.delete(ip);
    throw new Error('De PIN-sessie is verlopen. Vraag één nieuwe PIN aan.');
  }
  const cleanPin=String(pin||'').trim();
  if(!/^\d{4,8}$/.test(cleanPin))throw new Error('Vul de PIN van de TV in.');

  const credentials={username:state.deviceId,password:state.authKey};
  const body={auth:{auth_AppId:'1',pin:cleanPin,auth_timestamp:state.timestamp,auth_signature:pairingSignature(state.timestamp,cleanPin)},device:pairingDevice(state.deviceId)};
  const grantUrl=`https://${ip}:1926/6/pair/grant`;
  console.log(`[PAIR] Granting ${ip}...`);
  const data=await authenticatedPhilipsJson(grantUrl,{method:'POST',body,headers:{'Content-Type':'application/json'}},credentials);
  if(data.error_id&&data.error_id!=='SUCCESS')throw new Error(data.error_text||data.error_id||'PIN rejected');

  let d=saveDevice({...(getSaved(`philips:${ip}`)||{}),id:`philips:${ip}`,ip,brand:'philips',credentials,pairingPending:false,paired:true});
  pairSessions.delete(ip);
  try{
    const s=await philipsSystem(d);
    d=saveDevice({...d,name:s.name||d.name||'Philips TV',model:s.model||d.model||'Smart TV',apiVersion:s.api_version||6});
  }catch(e){console.warn('[PAIR] Paired, system read skipped:',e.message)}
  console.log(`[PAIR] SUCCESS ${ip}`);
  return {ok:true,device:{...d,credentials:undefined},message:'Gekoppeld en verbonden.'};
}

function philipsBase(d,secure=true){return secure?`https://${d.ip}:1926/6/`:`http://${d.ip}:1925/1/`}
async function httpJson(url,opts={}){
  const r=await fetch(url,{...opts,signal:opts.signal||timeoutSignal(4000)});
  const text=await r.text();const data=parseJson(text);
  if(!r.ok)throw new Error(data.error||data.message||`TV returned HTTP ${r.status}`);
  return data;
}
async function philipsRequest(d,endpoint,{method='GET',body}={}){
  if(d.credentials?.username&&d.credentials?.password){
    return authenticatedPhilipsJson(philipsBase(d,true)+endpoint,{method,body,headers:{'Content-Type':'application/json'}},d.credentials);
  }
  try{return await httpJson(philipsBase(d,false)+endpoint,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})}
  catch{throw new Error('This Philips TV requires one-time PIN pairing.')}
}

const KEY_MAP={Standby:'Standby',Mute:'Mute',Home:'Home',Source:'Source',Options:'Options',CursorUp:'CursorUp',CursorDown:'CursorDown',CursorLeft:'CursorLeft',CursorRight:'CursorRight',Confirm:'Confirm',Back:'Back',Info:'Info',VolumeDown:'VolumeDown',VolumeUp:'VolumeUp',Rewind:'Rewind',PlayPause:'PlayPause',FastForward:'FastForward',Guide:'Guide',Settings:'Adjust',ChannelStepUp:'ChannelStepUp',ChannelStepDown:'ChannelStepDown',Digit0:'Digit0',Digit1:'Digit1',Digit2:'Digit2',Digit3:'Digit3',Digit4:'Digit4',Digit5:'Digit5',Digit6:'Digit6',Digit7:'Digit7',Digit8:'Digit8',Digit9:'Digit9'};
async function philipsSystem(d){return philipsRequest(d,'system')}
async function philipsKey(d,key){return philipsRequest(d,'input/key',{method:'POST',body:{key:KEY_MAP[key]||key}})}
async function philipsStatus(d){
  const out={};
  try{const a=await philipsRequest(d,'audio/volume');out.volume=a.current;out.muted=a.muted}catch{}
  try{const c=await philipsRequest(d,'activities/current');out.source=c.channel?.name||c.component?.label||c.component?.source||null;out.app=c.intent?.component?.packageName||null}catch{}
  try{const x=await philipsRequest(d,'ambilight/currentconfiguration');out.ambilight=x.style||x.menuSetting||'On'}catch{}
  return out;
}
async function philipsVolume(d,volume){let cur={};try{cur=await philipsRequest(d,'audio/volume')}catch{};return philipsRequest(d,'audio/volume',{method:'POST',body:{muted:false,current:Math.max(0,Math.min(Number(cur.max||60),Number(volume)))}})}
async function philipsApps(d){const data=await philipsRequest(d,'applications');const list=data.applications||data.apps||[];return list.map((a,i)=>({id:a.id||a.intent?.component?.packageName||String(i),name:a.label||a.name||a.intent?.component?.packageName||`App ${i+1}`,raw:a}))}
async function philipsLaunch(d,appData){const a=appData.raw||appData;if(a.intent)return philipsRequest(d,'activities/launch',{method:'POST',body:a});if(a.id)return philipsRequest(d,'activities/launch',{method:'POST',body:{intent:{component:{packageName:a.id}}}});throw new Error('This app has no launch intent')}
async function philipsAmbilight(d,p){if(p.mode==='off')return philipsRequest(d,'ambilight/power',{method:'POST',body:{power:'Off'}});try{await philipsRequest(d,'ambilight/power',{method:'POST',body:{power:'On'}})}catch{};if(p.mode==='manual')throw new Error('Static RGB control is not exposed consistently on this Philips firmware.');return philipsRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{style:p.mode==='follow_audio'?'FOLLOW_AUDIO':'FOLLOW_VIDEO'}})}
function adapter(d){return String(d.brand||'').toLowerCase()==='philips'?'philips':'unsupported'}

function localIPv4s(){const out=[];for(const items of Object.values(os.networkInterfaces()))for(const i of items||[]){if(i.family==='IPv4'&&!i.internal&&/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(i.address))out.push(i.address)}return [...new Set(out)]}
function localSubnets(){return [...new Set(localIPv4s().map(ip=>ip.split('.').slice(0,3).join('.')))]}
function tcpProbe(host,port,timeout=320){return new Promise(resolve=>{const s=new net.Socket();let done=false;const finish=v=>{if(done)return;done=true;try{s.destroy()}catch{}resolve(v)};s.setTimeout(timeout);s.once('connect',()=>finish(true));s.once('timeout',()=>finish(false));s.once('error',()=>finish(false));s.connect(port,host)})}
async function probePhilips(ip){const [p1925,p1926]=await Promise.all([tcpProbe(ip,1925),tcpProbe(ip,1926)]);if(!p1925&&!p1926)return null;let name='Philips TV',model='Smart TV',api=p1926?'JointSpace v6':'JointSpace';if(p1925){try{const s=await httpJson(`http://${ip}:1925/1/system`);name=s.name||s.serialnumber||name;model=s.model||model}catch{}}return {id:`philips:${ip}`,ip,brand:'philips',name,model,api,ports:{jointspace1925:p1925,jointspace1926:p1926}}}
async function ssdpDiscover(timeout=2500){return new Promise(resolve=>{const client=new Client();const found=new Map();client.on('response',async headers=>{try{const loc=headers.LOCATION||headers.Location;const ip=loc?new URL(loc).hostname:null;if(!ip||found.has(ip))return;const p=await probePhilips(ip);if(p)found.set(ip,p)}catch{}});try{client.search('ssdp:all')}catch{}setTimeout(()=>{try{client.stop()}catch{}resolve([...found.values()])},timeout)})}
async function subnetPhilipsScan(){const found=[];for(const subnet of localSubnets()){const ips=Array.from({length:254},(_,i)=>`${subnet}.${i+1}`);for(let start=0;start<ips.length;start+=32){const matches=await Promise.all(ips.slice(start,start+32).map(probePhilips));found.push(...matches.filter(Boolean))}}return found}
async function discover(){const map=new Map();(await ssdpDiscover()).forEach(d=>map.set(d.ip,d));(await subnetPhilipsScan()).forEach(d=>map.set(d.ip,{...(map.get(d.ip)||{}),...d}));return [...map.values()]}

app.get('/api/health',(req,res)=>res.json({ok:true,name:'Smart TV Controller Bridge',version:VERSION,time:new Date().toISOString(),localIPv4s:localIPv4s(),subnets:localSubnets(),pairing:'single-flight-no-request-retry'}));
app.get('/api/network',(req,res)=>res.json({localIPv4s:localIPv4s(),subnets:localSubnets(),hostname:os.hostname()}));
app.post('/api/discover',async(req,res)=>{try{res.json({devices:await discover()})}catch(e){console.error('Discovery error:',e);res.status(500).json({error:e.message})}});
app.post('/api/pair/request',async(req,res)=>{try{const ip=String(req.body?.ip||'').trim();if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip))throw new Error('Enter a valid TV IP address');res.json(await philipsPairRequest(ip))}catch(e){console.error('Pair request error:',e);res.status(400).json({error:e.message})}});
app.post('/api/pair/grant',async(req,res)=>{try{const ip=String(req.body?.ip||'').trim();res.json(await philipsPairGrant(ip,req.body?.pin))}catch(e){console.error('Pair grant error:',e);res.status(400).json({error:e.message})}});
app.post('/api/connect',async(req,res)=>{try{const incoming=req.body||{};if(!incoming.ip)throw new Error('Missing TV IP address');let d=saveDevice({...incoming,brand:String(incoming.brand||'philips').toLowerCase(),id:idFor(incoming)});if(adapter(d)!=='philips')throw new Error('TV adapter not supported yet');try{const s=await philipsSystem(d);d=saveDevice({...d,name:s.name||d.name,model:s.model||d.model,apiVersion:s.api_version||null})}catch(e){if(!d.credentials)return res.status(401).json({error:'This Philips TV needs one-time PIN pairing.',needsPairing:true,device:{...d,credentials:undefined}});throw e}res.json({ok:true,device:{...d,credentials:undefined}})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/status',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');res.json(await philipsStatus(d))}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/key',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsKey(d,req.body.key);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/volume',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsVolume(d,req.body.volume);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/apps',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');res.json({apps:await philipsApps(d)})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/apps/launch',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsLaunch(d,req.body.app);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/ambilight',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsAmbilight(d,req.body);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/text',(req,res)=>res.status(501).json({error:'Text entry is TV/firmware specific and is not enabled yet.'}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));

const server=app.listen(PORT,'0.0.0.0',()=>{
  console.log('\n================================================');
  console.log(` Smart TV Controller Bridge v${VERSION}`);
  console.log(` Open app:   http://localhost:${PORT}`);
  console.log(` Health:     http://localhost:${PORT}/api/health`);
  console.log(` Local IPs:  ${localIPv4s().join(', ')||'none detected'}`);
  console.log(` Scan nets:  ${localSubnets().map(x=>x+'.0/24').join(', ')||'none detected'}`);
  console.log(' Pairing:    single-flight / no pair-request retries');
  console.log('================================================\n');
});
server.on('error',e=>{console.error('Bridge could not start:',e.message);process.exitCode=1});