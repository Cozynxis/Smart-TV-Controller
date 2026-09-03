const fs=require('fs');
const path=require('path');
const http=require('http');
const express=require('express');

const STORE=path.join(__dirname,'devices.local.json');
let active=null;

function readStore(){try{return JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{return {devices:{}}}}
function resolveTv(body={}){const ds=readStore().devices||{};if(body.ip)return body.ip;if(body.deviceId&&ds[body.deviceId]?.ip)return ds[body.deviceId].ip;const ids=Object.keys(ds);if(ids.length===1)return ds[ids[0]].ip;throw new Error('Geen TV IP gevonden voor countdown.');}
function clamp(n,min,max,def){n=Number(n);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):def}
function color(v,def){v=String(v||def||'').trim();return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)?v:def}
function safe(v,max){return String(v||'').slice(0,max)}
function postJson(ip,endpoint,body={},timeout=4500){return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body));const req=http.request({hostname:ip,port:7979,path:endpoint,method:'POST',timeout,headers:{'Content-Type':'application/json','Content-Length':data.length}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode||0,text}))});req.on('timeout',()=>req.destroy(new Error('PiPup timeout')));req.on('error',reject);req.write(data);req.end()})}
function nativePosition(p){if(typeof p==='number')return clamp(p,0,4,4);const map={'top-right':0,'top-left':1,'bottom-right':2,'bottom-left':3,'center':4};return map[p]??4}
function format(ms,showDays=true){const total=Math.max(0,Math.ceil(ms/1000));const d=Math.floor(total/86400);const h=Math.floor((total%86400)/3600);const m=Math.floor((total%3600)/60);const s=total%60;const pad=n=>String(n).padStart(2,'0');return showDays?`${String(d).padStart(2,'0')}:${pad(h)}:${pad(m)}:${pad(s)}`:`${pad(d*24+h)}:${pad(m)}:${pad(s)}`}
function payloadFor(a,remaining){const timer=format(remaining,a.showDays);const message=a.label?`${a.label}\n${timer}`:timer;return {duration:2,position:a.position,title:a.title,titleColor:a.titleColor,titleSize:a.titleSize,message,messageColor:a.messageColor,messageSize:a.messageSize,backgroundColor:a.backgroundColor}}
async function cancelPopup(ip){try{await postJson(ip,'/cancel',{})}catch{}}
async function push(){if(!active||active.paused)return;const remaining=active.endAt-Date.now();if(remaining<=0){const done=active;clearInterval(done.interval);active=null;if(done.showFinished){try{await postJson(done.ip,'/notify',{duration:5,position:done.position,title:done.finishedTitle,titleColor:done.titleColor,titleSize:done.titleSize,message:done.finishedMessage,messageColor:done.messageColor,messageSize:done.messageSize,backgroundColor:done.backgroundColor})}catch{}}else await cancelPopup(done.ip);return;}try{await postJson(active.ip,'/notify',payloadFor(active,remaining));active.lastError=null}catch(e){active.lastError=e.message}}
function snapshot(){if(!active)return {active:false};const remaining=active.paused?active.pausedRemaining:Math.max(0,active.endAt-Date.now());return {active:true,paused:active.paused,remainingMs:remaining,endAt:active.paused?null:active.endAt,ip:active.ip,position:active.position,title:active.title,label:active.label,lastError:active.lastError||null,display:format(remaining,active.showDays)}}
async function startCountdown(body){const ip=resolveTv(body);const days=clamp(body.days,0,3650,0),hours=clamp(body.hours,0,23,0),minutes=clamp(body.minutes,0,59,0),seconds=clamp(body.seconds,0,59,0);const totalMs=((days*24*60*60)+(hours*60*60)+(minutes*60)+seconds)*1000;if(totalMs<1000)throw new Error('Countdown moet minimaal 1 seconde zijn.');if(active){clearInterval(active.interval);await cancelPopup(active.ip)}active={ip,totalMs,endAt:Date.now()+totalMs,paused:false,pausedRemaining:0,position:nativePosition(body.position),title:safe(body.title||'COUNTDOWN',80),label:safe(body.label||'',120),titleColor:color(body.titleColor,'#FFFFFF'),messageColor:color(body.messageColor,'#FFFFFF'),backgroundColor:color(body.backgroundColor,'#E6111820'),titleSize:clamp(body.titleSize,8,60,18),messageSize:clamp(body.messageSize,12,72,34),showDays:body.showDays!==false,showFinished:body.showFinished!==false,finishedTitle:safe(body.finishedTitle||'COUNTDOWN',80),finishedMessage:safe(body.finishedMessage||'Tijd is voorbij!',160),lastError:null,interval:null};await push();active.interval=setInterval(push,1000);active.interval.unref?.();return snapshot()}

const oldListen=express.application.listen;
express.application.listen=function(...args){if(!this.__countdownRoutes){this.__countdownRoutes=true;
 this.post('/api/countdown/start',async(req,res)=>{try{res.json({ok:true,...await startCountdown(req.body||{})})}catch(e){res.status(400).json({error:e.message,code:'countdown_start_failed'})}});
 this.get('/api/countdown/status',(req,res)=>res.json(snapshot()));
 this.post('/api/countdown/pause',async(req,res)=>{try{if(!active)return res.json({ok:true,active:false});if(!active.paused){active.pausedRemaining=Math.max(0,active.endAt-Date.now());active.paused=true;await cancelPopup(active.ip)}res.json({ok:true,...snapshot()})}catch(e){res.status(500).json({error:e.message})}});
 this.post('/api/countdown/resume',async(req,res)=>{try{if(!active)return res.status(404).json({error:'Geen actieve countdown.'});if(active.paused){active.endAt=Date.now()+active.pausedRemaining;active.paused=false;await push()}res.json({ok:true,...snapshot()})}catch(e){res.status(500).json({error:e.message})}});
 this.post('/api/countdown/stop',async(req,res)=>{try{if(active){const old=active;clearInterval(old.interval);active=null;await cancelPopup(old.ip)}else{try{await cancelPopup(resolveTv(req.body||{}))}catch{}}res.json({ok:true,active:false})}catch(e){res.status(500).json({error:e.message})}});
 }
 return oldListen.apply(this,args)};

console.log('[COUNTDOWN] Native PiPup countdown engine v1 ready');