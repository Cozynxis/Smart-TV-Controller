const express=require('express');
const cors=require('cors');
const {Client}=require('node-ssdp');
const fs=require('fs');
const path=require('path');
const os=require('os');
const http=require('http');
const https=require('https');
const crypto=require('crypto');
const DigestModule=require('digest-fetch');
const DigestFetch=DigestModule.default||DigestModule;

const app=express();
const PORT=Number(process.env.PORT||8765);
const STORE=path.join(__dirname,'devices.local.json');
const ROOT=path.resolve(__dirname,'..');
const PAIR_SECRET='ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==';
const pairSessions=new Map();

app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Private-Network','true');
  res.setHeader('Cache-Control','no-store');
  next();
});
app.use(cors({origin:true,credentials:false,methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type']}));
app.options('*',cors());
app.use(express.json({limit:'256kb'}));
app.use(express.static(ROOT));

let store={devices:{}};
try{store=JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{}
function persist(){fs.writeFileSync(STORE,JSON.stringify(store,null,2))}
function idFor(d){return d.id||`${(d.brand||'generic').toLowerCase()}:${d.ip}`}
function getSaved(id){return store.devices[id]||null}
function saveDevice(d){const id=idFor(d);store.devices[id]={...(store.devices[id]||{}),...d,id};persist();return store.devices[id]}

const insecureAgent=new https.Agent({rejectUnauthorized:false});
function timeoutSignal(ms=2500){return typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(ms):undefined}
function parseJson(text){try{return text?JSON.parse(text):{}}catch{return {raw:text}}}

function rawHttpsJson(url,{method='GET',body,headers={}}={}){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const payload=body===undefined?null:(typeof body==='string'?body:JSON.stringify(body));
    const req=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method,rejectUnauthorized:false,timeout:5000,headers:{Accept:'application/json',...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{
        const data=parseJson(text);
        if(res.statusCode<200||res.statusCode>=300)return reject(Object.assign(new Error(data.error||data.message||`TV returned HTTP ${res.statusCode}`),{status:res.statusCode,data}));
        resolve(data);
      });
    });
    req.on('timeout',()=>req.destroy(new Error('TV request timed out')));
    req.on('error',reject);
    if(payload)req.write(payload);
    req.end();
  });
}

async function fetchJson(url,opts={},credentials){
  let response;
  const finalOpts={...opts,signal:opts.signal||timeoutSignal(4000)};
  if(credentials?.username&&credentials?.password){
    const client=new DigestFetch(credentials.username,credentials.password,{basic:false});
    response=await client.fetch(url,{...finalOpts,agent:insecureAgent});
  }else if(url.startsWith('https://')){
    return rawHttpsJson(url,{method:opts.method||'GET',body:opts.body,headers:opts.headers});
  }else response=await fetch(url,finalOpts);
  const text=await response.text();
  const data=parseJson(text);
  if(!response.ok)throw new Error(data.error||data.message||`TV returned HTTP ${response.status}`);
  return data;
}

function philipsBase(d,secure=true){return secure?`https://${d.ip}:1926/6/`:`http://${d.ip}:1925/1/`}
async function philipsRequest(d,endpoint,{method='GET',body}={}){
  const creds=d.credentials;
  if(creds?.username&&creds?.password){
    return fetchJson(philipsBase(d,true)+endpoint,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined},creds);
  }
  try{
    return await fetchJson(philipsBase(d,false)+endpoint,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  }catch(legacyError){
    throw new Error('This Philips TV requires one-time PIN pairing.');
  }
}

function randomDeviceId(){
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out='';for(let i=0;i<16;i++)out+=chars[crypto.randomInt(0,chars.length)];return out;
}
function pairingDevice(deviceId){return {device_name:'Smart TV Controller',device_os:process.platform==='win32'?'Windows':'Desktop',app_name:'Smart TV Controller',type:'native',app_id:'app.id',id:deviceId}}
function pairingSignature(timestamp,pin){
  const key=Buffer.from(PAIR_SECRET,'base64');
  const hex=crypto.createHmac('sha1',key).update(String(timestamp)+String(pin)).digest('hex');
  return Buffer.from(hex,'utf8').toString('base64');
}
async function philipsPairRequest(ip){
  const deviceId=randomDeviceId();
  const body={scope:['read','write','control'],device:pairingDevice(deviceId)};
  const response=await rawHttpsJson(`https://${ip}:1926/6/pair/request`,{method:'POST',body});
  if(response.error_id&&response.error_id!=='SUCCESS')throw new Error(response.error_text||response.error_id||'TV rejected pairing request');
  if(!response.auth_key||response.timestamp===undefined)throw new Error('TV did not return pairing credentials.');
  const state={ip,deviceId,authKey:response.auth_key,timestamp:response.timestamp,createdAt:Date.now(),timeout:response.timeout||60};
  pairSessions.set(ip,state);
  saveDevice({id:`philips:${ip}`,ip,brand:'philips',name:'Philips TV',pairingPending:true});
  return {ok:true,ip,timeout:state.timeout,message:'PIN requested. Check the TV screen.'};
}
async function philipsPairGrant(ip,pin){
  const state=pairSessions.get(ip);
  if(!state)throw new Error('No active pairing request. Click Request PIN first.');
  if(Date.now()-state.createdAt>Math.max(120000,Number(state.timeout||60)*1000+30000)){pairSessions.delete(ip);throw new Error('Pairing request expired. Request a new PIN.');}
  if(!/^\d{4,8}$/.test(String(pin).trim()))throw new Error('Enter the PIN shown on the TV.');
  const body={auth:{auth_AppId:'1',pin:String(pin).trim(),auth_timestamp:state.timestamp,auth_signature:pairingSignature(state.timestamp,String(pin).trim())},device:pairingDevice(state.deviceId)};
  const credentials={username:state.deviceId,password:state.authKey};
  const client=new DigestFetch(credentials.username,credentials.password,{basic:false});
  const response=await client.fetch(`https://${ip}:1926/6/pair/grant`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),agent:insecureAgent});
  const text=await response.text();const data=parseJson(text);
  if(!response.ok)throw new Error(data.error_text||data.error||data.message||`Pairing failed (HTTP ${response.status})`);
  if(data.error_id&&data.error_id!=='SUCCESS')throw new Error(data.error_text||data.error_id||'Incorrect PIN or pairing rejected');
  let d=saveDevice({...(getSaved(`philips:${ip}`)||{}),id:`philips:${ip}`,ip,brand:'philips',credentials,pairingPending:false,paired:true});
  try{const s=await philipsSystem(d);d=saveDevice({...d,name:s.name||d.name||'Philips TV',model:s.model||d.model||'Smart TV',apiVersion:s.api_version||6})}catch(e){console.warn('Pairing succeeded but system read failed:',e.message)}
  pairSessions.delete(ip);
  return {ok:true,device:{...d,credentials:undefined},message:'Paired and connected.'};
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
async function philipsAmbilight(d,p){
  if(p.mode==='off')return philipsRequest(d,'ambilight/power',{method:'POST',body:{power:'Off'}});
  try{await philipsRequest(d,'ambilight/power',{method:'POST',body:{power:'On'}})}catch{}
  if(p.mode==='manual')throw new Error('Static RGB control is not exposed consistently on this Philips firmware. Try Follow video/audio.');
  return philipsRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{style:p.mode==='follow_audio'?'FOLLOW_AUDIO':'FOLLOW_VIDEO'}});
}
function adapter(d){return (d.brand||'').toLowerCase()==='philips'?'philips':'unsupported'}

function localIPv4s(){
  const out=[];
  for(const items of Object.values(os.networkInterfaces())) for(const i of items||[]){
    if(i.family==='IPv4'&&!i.internal&&/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) out.push(i.address);
  }
  return [...new Set(out)];
}
function localSubnets(){return [...new Set(localIPv4s().map(ip=>ip.split('.').slice(0,3).join('.')))]}
function tcpProbe(host,port,timeout=320){return new Promise(resolve=>{
  const net=require('net');const s=new net.Socket();let done=false;
  const finish=v=>{if(done)return;done=true;try{s.destroy()}catch{};resolve(v)};
  s.setTimeout(timeout);s.once('connect',()=>finish(true));s.once('timeout',()=>finish(false));s.once('error',()=>finish(false));s.connect(port,host);
})}
async function probePhilips(ip){
  const [p1925,p1926]=await Promise.all([tcpProbe(ip,1925),tcpProbe(ip,1926)]);
  if(!p1925&&!p1926)return null;
  let name='Philips TV',model='Smart TV',api=p1926?'JointSpace v6':'JointSpace';
  if(p1925){
    try{const s=await fetchJson(`http://${ip}:1925/1/system`,{},null);name=s.name||s.serialnumber||name;model=s.model||model}catch{}
  }
  return {id:`philips:${ip}`,ip,brand:'philips',name,model,api,ports:{jointspace1925:p1925,jointspace1926:p1926}};
}
async function identify(ip,meta={}){
  const lower=`${meta.server||''} ${meta.usn||''} ${meta.location||''}`.toLowerCase();
  let brand=lower.includes('philips')?'philips':'generic',model='Smart TV',name='Smart TV';
  if(brand==='philips'){
    const p=await probePhilips(ip);if(p)return {...p,location:meta.location||null};
  }
  return {id:`${brand}:${ip}`,ip,brand,name,model,location:meta.location||null};
}
async function ssdpDiscover(timeout=3000){return new Promise(resolve=>{
  const client=new Client();const found=new Map();
  client.on('response',async(headers)=>{try{const loc=headers.LOCATION||headers.Location;const ip=loc?new URL(loc).hostname:null;if(!ip||found.has(ip))return;const d=await identify(ip,{server:headers.SERVER,usn:headers.USN,location:loc});found.set(ip,d)}catch{}});
  try{client.search('ssdp:all')}catch{}
  setTimeout(()=>{try{client.stop()}catch{};resolve([...found.values()])},timeout);
})}
async function subnetPhilipsScan(){
  const subnets=localSubnets();const found=[];
  for(const subnet of subnets){
    const ips=Array.from({length:254},(_,i)=>`${subnet}.${i+1}`);
    for(let start=0;start<ips.length;start+=32){
      const batch=ips.slice(start,start+32);
      const matches=await Promise.all(batch.map(probePhilips));
      found.push(...matches.filter(Boolean));
    }
  }
  return found;
}
async function discover(){
  const map=new Map();
  const ssdp=await ssdpDiscover();ssdp.forEach(d=>map.set(d.ip,d));
  const philips=await subnetPhilipsScan();philips.forEach(d=>map.set(d.ip,{...(map.get(d.ip)||{}),...d}));
  return [...map.values()].filter(d=>d.brand==='philips'||d.brand!=='generic');
}

app.get('/api/health',(req,res)=>res.json({ok:true,name:'Smart TV Controller Bridge',version:'0.3.0',time:new Date().toISOString(),localIPv4s:localIPv4s(),subnets:localSubnets(),pairing:'automatic-pin'}));
app.get('/api/network',(req,res)=>res.json({localIPv4s:localIPv4s(),subnets:localSubnets(),hostname:os.hostname()}));
app.post('/api/discover',async(req,res)=>{try{res.json({devices:await discover()})}catch(e){console.error('Discovery error:',e);res.status(500).json({error:e.message})}});
app.post('/api/pair/request',async(req,res)=>{try{const ip=String(req.body?.ip||'').trim();if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip))throw new Error('Enter a valid TV IP address');res.json(await philipsPairRequest(ip))}catch(e){console.error('Pair request error:',e);res.status(400).json({error:e.message})}});
app.post('/api/pair/grant',async(req,res)=>{try{const ip=String(req.body?.ip||'').trim(),pin=String(req.body?.pin||'').trim();res.json(await philipsPairGrant(ip,pin))}catch(e){console.error('Pair grant error:',e);res.status(400).json({error:e.message})}});
app.post('/api/connect',async(req,res)=>{try{const incoming=req.body||{};if(!incoming.ip)throw new Error('Missing TV IP address');let d=saveDevice({...incoming,brand:(incoming.brand||'philips').toLowerCase(),id:idFor(incoming)});if(adapter(d)==='philips'){try{const s=await philipsSystem(d);d=saveDevice({...d,name:s.name||d.name,model:s.model||d.model,apiVersion:s.api_version||null})}catch(e){if(!d.credentials)return res.status(401).json({error:'This Philips TV needs one-time PIN pairing.',needsPairing:true,needsCredentials:true,device:{...d,credentials:undefined}});throw e}}else throw new Error('This TV was found, but its adapter is not supported yet. Philips JointSpace is implemented first.');res.json({ok:true,device:{...d,credentials:undefined}})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/credentials',(req,res)=>{try{const {deviceId,ip,brand='philips',username,password}=req.body;if(!username||!password)throw new Error('Username and password are required');const id=deviceId||`${brand}:${ip}`;const d=getSaved(id)||{id,ip,brand};saveDevice({...d,credentials:{username,password}});res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/status',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');res.json(await philipsStatus(d))}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/key',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsKey(d,req.body.key);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/volume',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsVolume(d,req.body.volume);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/apps',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');res.json({apps:await philipsApps(d)})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/apps/launch',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsLaunch(d,req.body.app);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/ambilight',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsAmbilight(d,req.body);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/text',(req,res)=>res.status(501).json({error:'Text entry is TV/firmware specific and is not enabled in this adapter yet.'}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));

const server=app.listen(PORT,'0.0.0.0',()=>{
  console.log('\n================================================');
  console.log(' Smart TV Controller Bridge v0.3.0');
  console.log(` Open app:   http://localhost:${PORT}`);
  console.log(` Health:     http://localhost:${PORT}/api/health`);
  console.log(` Local IPs:  ${localIPv4s().join(', ')||'none detected'}`);
  console.log(` Scan nets:  ${localSubnets().map(x=>x+'.0/24').join(', ')||'none detected'}`);
  console.log(' Pairing:    automatic Philips PIN flow');
  console.log('================================================\n');
});
server.on('error',e=>{console.error('Bridge could not start:',e.message);process.exitCode=1});
