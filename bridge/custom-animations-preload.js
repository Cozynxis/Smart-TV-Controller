const fs=require('fs');
const path=require('path');
const express=require('express');

const STORE=path.join(__dirname,'devices.local.json');
const sessions=new Map();

function readStore(){try{return JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{return {devices:{}}}}
function getDevice(id){const d=readStore().devices?.[id];if(!d)throw Object.assign(new Error('Unknown saved TV'),{status:404});return d}
function cleanEndpoint(e){return String(e||'').replace(/^\/+|\/+$/g,'')}
async function requestTv(d,endpoint,{method='GET',body}={}){
  const ep=cleanEndpoint(endpoint),preferred=Number(d.apiVersion||6),versions=[preferred,...[6,1].filter(v=>v!==preferred)],urls=[...new Set([...versions.map(v=>`http://${d.ip}:1925/${v}/${ep}`),`http://${d.ip}:1925/${ep}`])];
  let last;
  for(const url of urls){try{const r=await fetch(url,{method,headers:{Accept:'application/json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(3500)});const text=await r.text();if(r.ok)return text?JSON.parse(text):{};if(r.status===404){last=new Error(`HTTP 404 at ${new URL(url).pathname}`);continue}throw new Error(`TV HTTP ${r.status}${text?`: ${text.slice(0,120)}`:''}`)}catch(e){last=e;if(/404/.test(e.message))continue;throw e}}throw last||new Error(`No working route for ${ep}`)
}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function rgb(hex){const s=String(hex||'#000000').replace('#','');return {r:parseInt(s.slice(0,2),16)||0,g:parseInt(s.slice(2,4),16)||0,b:parseInt(s.slice(4,6),16)||0}}
function mix(a,b,t){return {r:Math.round(a.r+(b.r-a.r)*t),g:Math.round(a.g+(b.g-a.g)*t),b:Math.round(a.b+(b.b-a.b)*t)}}
function ease(t,type){t=clamp(t,0,1);if(type==='linear')return t;if(type==='ease-in')return t*t;if(type==='ease-out')return 1-(1-t)*(1-t);return t*t*(3-2*t)}
function normalizeAnimation(a){if(!a||!Array.isArray(a.frames)||a.frames.length<2)throw new Error('Animation needs at least 2 keyframes');const duration=clamp(Number(a.duration)||6,.2,300),fps=clamp(Math.round(Number(a.fps)||12),4,30);const frames=a.frames.map(f=>({time:clamp(Number(f.time)||0,0,duration),pixels:f.pixels&&typeof f.pixels==='object'?f.pixels:{}})).sort((x,y)=>x.time-y.time);return {...a,duration,fps,frames,easing:['linear','ease-in','ease-out','smoothstep'].includes(a.easing)?a.easing:'smoothstep',loop:a.loop!==false,pingpong:!!a.pingpong}}
function sample(anim,t,ledIds){const fs=anim.frames;if(t<=fs[0].time)return fs[0].pixels;if(t>=fs[fs.length-1].time)return fs[fs.length-1].pixels;let a=fs[0],b=fs[1];for(let i=0;i<fs.length-1;i++){if(t>=fs[i].time&&t<=fs[i+1].time){a=fs[i];b=fs[i+1];break}}const k=ease((t-a.time)/Math.max(.001,b.time-a.time),anim.easing),out={};for(const id of ledIds)out[id]=mix(rgb(a.pixels[id]),rgb(b.pixels[id]),k);return out}
function topologyIds(t){const ids=[];for(const side of ['left','top','right'])for(let i=0;i<Number(t[side]||0);i++)ids.push(`${side}:${i}`);return ids}
function layerFromPixels(t,p){const layer1={};for(const side of ['left','top','right']){const n=Number(t[side]||0);if(!n)continue;const out={};for(let i=0;i<n;i++)out[String(i)]=p[`${side}:${i}`]||{r:0,g:0,b:0};layer1[side]=out}if(Number(t.bottom||0)>0){const o={};for(let i=0;i<Number(t.bottom);i++)o[String(i)]={r:0,g:0,b:0};layer1.bottom=o}return {layer1}}
function stop(id){const s=sessions.get(id);if(s){s.running=false;if(s.timer)clearTimeout(s.timer);sessions.delete(id)}return {ok:true,running:false}}
async function start(deviceId,animation){stop(deviceId);const d=getDevice(deviceId),anim=normalizeAnimation(animation);const topology=await requestTv(d,'ambilight/topology');if(!topology.left&&!topology.top&&!topology.right)throw new Error('TV reports no editable Ambilight topology');await requestTv(d,'ambilight/power',{method:'POST',body:{power:'On'}}).catch(()=>{});await requestTv(d,'ambilight/mode',{method:'POST',body:{current:'manual'}});const ids=topologyIds(topology),session={running:true,deviceId,animation:anim,topology,started:Date.now(),frames:0,lastError:null,timer:null,direction:1};sessions.set(deviceId,session);
  const frameMs=Math.max(33,Math.round(1000/anim.fps));
  const loop=async()=>{if(!session.running)return;const now=Date.now(),elapsed=(now-session.started)/1000;let t=elapsed;if(anim.pingpong){const cycle=anim.duration*2,t2=elapsed%cycle;t=t2<=anim.duration?t2:cycle-t2}else if(anim.loop)t=elapsed%anim.duration;else if(t>anim.duration){stop(deviceId);return}const pixels=sample(anim,t,ids),started=Date.now();try{await requestTv(d,'ambilight/cached',{method:'POST',body:layerFromPixels(topology,pixels)});session.frames++;session.lastError=null}catch(e){session.lastError=e.message;session.running=false;sessions.delete(deviceId);return}session.timer=setTimeout(loop,Math.max(5,frameMs-(Date.now()-started)))};
  loop();return {ok:true,running:true,title:anim.title||'Custom animation',emoji:anim.emoji||'✨',duration:anim.duration,fps:anim.fps,topology}
}
function status(id){const s=sessions.get(id);return s?{running:s.running,title:s.animation.title,emoji:s.animation.emoji,frames:s.frames,fps:s.animation.fps,duration:s.animation.duration,lastError:s.lastError}:{running:false}}

const originalListen=express.application.listen;
express.application.listen=function(...args){
  if(!this.__customAnimationsInstalled){this.__customAnimationsInstalled=true;
    this.post('/api/ambilight/custom/start',async(req,res)=>{try{const {deviceId,animation}=req.body||{};if(!deviceId)throw new Error('Missing deviceId');try{await fetch('http://127.0.0.1:8765/api/ambilight/animation/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId}),signal:AbortSignal.timeout(1200)})}catch{}res.json(await start(deviceId,animation))}catch(e){res.status(e.status||400).json({error:e.message,code:'custom_animation_error'})}});
    this.post('/api/ambilight/custom/stop',(req,res)=>{try{res.json(stop(req.body?.deviceId))}catch(e){res.status(400).json({error:e.message})}});
    this.get('/api/ambilight/custom/status',(req,res)=>{try{res.json(status(req.query?.deviceId))}catch(e){res.status(400).json({error:e.message})}});
  }
  return originalListen.apply(this,args)
};
console.log('[AMBI] Custom timeline animation engine preloaded');