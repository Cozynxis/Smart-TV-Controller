const express=require('express');
const cors=require('cors');
const {Client}=require('node-ssdp');
const fs=require('fs');
const path=require('path');
const https=require('https');
const DigestModule=require('digest-fetch');
const DigestFetch=DigestModule.default||DigestModule;

const app=express();
const PORT=Number(process.env.PORT||8765);
const STORE=path.join(__dirname,'devices.local.json');
const ROOT=path.resolve(__dirname,'..');
app.use(cors());
app.use(express.json({limit:'256kb'}));
app.use(express.static(ROOT));

let store={devices:{}};
try{store=JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{}
function persist(){fs.writeFileSync(STORE,JSON.stringify(store,null,2))}
function idFor(d){return d.id||`${(d.brand||'generic').toLowerCase()}:${d.ip}`}
function getSaved(id){return store.devices[id]||null}
function saveDevice(d){const id=idFor(d);store.devices[id]={...(store.devices[id]||{}),...d,id};persist();return store.devices[id]}

const insecureAgent=new https.Agent({rejectUnauthorized:false});
async function fetchJson(url,opts={},credentials){
  let response;
  if(credentials?.username&&credentials?.password){
    const client=new DigestFetch(credentials.username,credentials.password,{basic:false});
    response=await client.fetch(url,{...opts,agent:insecureAgent});
  }else response=await fetch(url,opts);
  const text=await response.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!response.ok)throw new Error(data.error||data.message||`TV returned HTTP ${response.status}`);
  return data;
}
function philipsBase(d,secure=true){return `${secure?'https':'http'}://${d.ip}:${secure?1926:1925}/${secure?'6/':''}`}
async function philipsRequest(d,endpoint,{method='GET',body}={}){
  const creds=d.credentials;
  if(creds?.username&&creds?.password){return fetchJson(philipsBase(d,true)+endpoint,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined},creds)}
  try{return await fetchJson(philipsBase(d,false)+endpoint,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})}
  catch(e){throw new Error('Philips TV requires pairing credentials. Open Devices → Credentials and enter the one-time JointSpace username/password for this TV.')}
}
const KEY_MAP={Standby:'Standby',Mute:'Mute',Home:'Home',Source:'Source',Options:'Options',CursorUp:'CursorUp',CursorDown:'CursorDown',CursorLeft:'CursorLeft',CursorRight:'CursorRight',Confirm:'Confirm',Back:'Back',Info:'Info',VolumeDown:'VolumeDown',VolumeUp:'VolumeUp',Rewind:'Rewind',PlayPause:'PlayPause',FastForward:'FastForward',Guide:'Guide',Settings:'Adjust',ChannelStepUp:'ChannelStepUp',ChannelStepDown:'ChannelStepDown',Digit0:'Digit0',Digit1:'Digit1',Digit2:'Digit2',Digit3:'Digit3',Digit4:'Digit4',Digit5:'Digit5',Digit6:'Digit6',Digit7:'Digit7',Digit8:'Digit8',Digit9:'Digit9'};
async function philipsSystem(d){return philipsRequest(d,'system')}
async function philipsKey(d,key){const mapped=KEY_MAP[key]||key;return philipsRequest(d,'input/key',{method:'POST',body:{key:mapped}})}
async function philipsStatus(d){
  const out={};
  try{const a=await philipsRequest(d,'audio/volume');out.volume=a.current;out.muted=a.muted}catch{}
  try{const c=await philipsRequest(d,'activities/current');out.source=c.channel?.name||c.component?.label||c.component?.source||null;out.app=c.intent?.component?.packageName||null}catch{}
  try{const x=await philipsRequest(d,'ambilight/currentconfiguration');out.ambilight=x.style||x.menuSetting||'On'}catch{}
  return out;
}
async function philipsVolume(d,volume){let cur={};try{cur=await philipsRequest(d,'audio/volume')}catch{};return philipsRequest(d,'audio/volume',{method:'POST',body:{muted:false,current:Math.max(0,Math.min(Number(cur.max||60),Number(volume)))}})}
async function philipsApps(d){const data=await philipsRequest(d,'applications');const list=data.applications||data.apps||[];return list.map((a,i)=>({id:a.id||a.intent?.component?.packageName||String(i),name:a.label||a.name||a.intent?.component?.packageName||`App ${i+1}`,raw:a}))}
async function philipsLaunch(d,appData){const app=appData.raw||appData;if(app.intent)return philipsRequest(d,'activities/launch',{method:'POST',body:app});if(app.id)return philipsRequest(d,'activities/launch',{method:'POST',body:{intent:{component:{packageName:app.id}}}});throw new Error('This app has no launch intent')}
async function philipsAmbilight(d,p){
  if(p.mode==='off')return philipsRequest(d,'ambilight/power',{method:'POST',body:{power:'Off'}});
  try{await philipsRequest(d,'ambilight/power',{method:'POST',body:{power:'On'}})}catch{}
  if(p.mode==='manual')throw new Error('Direct static RGB writing is not exposed consistently by Philips JointSpace on this model. Use a supported Ambilight mode instead.');
  const style=p.mode==='follow_audio'?'FOLLOW_AUDIO':'FOLLOW_VIDEO';
  return philipsRequest(d,'ambilight/currentconfiguration',{method:'POST',body:{style}})
}
function adapter(d){if((d.brand||'').toLowerCase()==='philips')return 'philips';return 'unsupported'}
async function identify(ip,meta={}){
  let brand=(meta.server||meta.usn||'').toLowerCase().includes('philips')?'philips':'generic',model='Smart TV',name='Smart TV';
  if(brand==='philips'){
    const temp={ip,brand};
    try{const sys=await fetchJson(`http://${ip}:1925/system`);name=sys.name||name;model=sys.model||sys.name||model}catch{}
  }
  return {id:`${brand}:${ip}`,ip,brand,name,model,location:meta.location||null};
}
async function discover(timeout=3500){return new Promise(resolve=>{
  const client=new Client();const found=new Map();
  client.on('response',async(headers)=>{try{const loc=headers.LOCATION||headers.Location;const ip=loc?new URL(loc).hostname:null;if(!ip||found.has(ip))return;const d=await identify(ip,{server:headers.SERVER,usn:headers.USN,location:loc});found.set(ip,d)}catch{}});
  client.search('ssdp:all');
  setTimeout(()=>{try{client.stop()}catch{};resolve([...found.values()])},timeout);
})}

app.get('/api/health',(req,res)=>res.json({ok:true,name:'Smart TV Controller Bridge',version:'0.1.0',time:new Date().toISOString()}));
app.post('/api/discover',async(req,res)=>{try{res.json({devices:await discover()})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/connect',async(req,res)=>{try{const incoming=req.body||{};if(!incoming.ip)throw new Error('Missing TV IP address');let d=saveDevice({...incoming,id:idFor(incoming)});if(adapter(d)==='philips'){try{const s=await philipsSystem(d);d=saveDevice({...d,name:s.name||d.name,model:s.model||d.model,apiVersion:s.api_version||null})}catch(e){if(!d.credentials) return res.status(401).json({error:e.message,needsCredentials:true,device:{...d,credentials:undefined}});throw e}}else throw new Error('This brand adapter is not implemented yet. Philips JointSpace is supported first.');res.json({ok:true,device:{...d,credentials:undefined}})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/credentials',(req,res)=>{try{const {deviceId,ip,brand='philips',username,password}=req.body;if(!username||!password)throw new Error('Username and password are required');const id=deviceId||`${brand}:${ip}`;const d=getSaved(id)||{id,ip,brand};saveDevice({...d,credentials:{username,password}});res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/status',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');if(adapter(d)!=='philips')throw new Error('Unsupported TV adapter');res.json(await philipsStatus(d))}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/key',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');if(adapter(d)!=='philips')throw new Error('Unsupported TV adapter');await philipsKey(d,req.body.key);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/volume',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsVolume(d,req.body.volume);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/apps',async(req,res)=>{try{const d=getSaved(req.query.deviceId);if(!d)throw new Error('Unknown device');res.json({apps:await philipsApps(d)})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/apps/launch',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsLaunch(d,req.body.app);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/ambilight',async(req,res)=>{try{const d=getSaved(req.body.deviceId);if(!d)throw new Error('Unknown device');await philipsAmbilight(d,req.body);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/text',(req,res)=>res.status(501).json({error:'Text entry is TV/firmware specific and is not enabled in this adapter yet.'}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));
app.listen(PORT,'0.0.0.0',()=>{console.log(`\nSmart TV Controller Bridge\nLocal app: http://localhost:${PORT}\nLAN bridge: http://0.0.0.0:${PORT}\n`)});
