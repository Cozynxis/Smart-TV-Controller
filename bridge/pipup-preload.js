const fs=require('fs');
const path=require('path');
const http=require('http');
const express=require('express');
const STORE=path.join(__dirname,'devices.local.json');
function readStore(){try{return JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{return {devices:{}}}}
function resolveTv(body={}){const ds=readStore().devices||{};if(body.ip)return body.ip;if(body.deviceId&&ds[body.deviceId]?.ip)return ds[body.deviceId].ip;const ids=Object.keys(ds);if(ids.length===1)return ds[ids[0]].ip;throw new Error('Geen TV IP gevonden voor announcement.');}
function clamp(n,min,max,def){n=Number(n);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):def}
function color(v,def){v=String(v||def||'').trim();return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)?v:def}
function safeText(v,max=500){return String(v||'').slice(0,max)}
function postJson(ip,endpoint,body,timeout=5000){return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body));const req=http.request({hostname:ip,port:7979,path:endpoint,method:'POST',timeout,headers:{'Content-Type':'application/json','Content-Length':data.length}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode||0,text}))});req.on('timeout',()=>req.destroy(new Error('PiPup timeout')));req.on('error',reject);req.write(data);req.end()})}
function nativePosition(p){if(typeof p==='number')return clamp(p,0,4,0);const map={'top-right':0,'top-left':1,'bottom-right':2,'bottom-left':3,'center':4,'top-center':4,'center-left':1,'center-right':0,'bottom-center':4};return map[p]??4}
const oldListen=express.application.listen;
express.application.listen=function(...args){if(!this.__pipupRoutes){this.__pipupRoutes=true;
 this.post('/api/announcements/test',async(req,res)=>{try{const ip=resolveTv(req.body);const r=await postJson(ip,'/notify',{duration:3,position:4,title:'Smart TV Controller',titleColor:'#6BB8FF',titleSize:20,message:'PiPup is verbonden met je panel.',messageColor:'#FFFFFF',messageSize:15,backgroundColor:'#CC111820'});res.status(r.status>=200&&r.status<300?200:502).json({ok:r.status>=200&&r.status<300,status:r.status,ip})}catch(e){res.status(502).json({error:e.message,code:'pipup_unavailable'})}});
 this.post('/api/announcements/send',async(req,res)=>{try{const ip=resolveTv(req.body),message=safeText(req.body?.message,700).trim();if(!message)throw new Error('Typ eerst een announcement.');const payload={duration:clamp(req.body?.duration,1,300,5),position:nativePosition(req.body?.position),title:safeText(req.body?.title,80),titleColor:color(req.body?.titleColor,'#FFFFFF'),titleSize:clamp(req.body?.titleSize,8,60,20),message,messageColor:color(req.body?.messageColor,'#FFFFFF'),messageSize:clamp(req.body?.messageSize,8,60,14),backgroundColor:color(req.body?.backgroundColor,'#CC000000')};const r=await postJson(ip,'/notify',payload);if(r.status<200||r.status>=300)throw new Error(`PiPup HTTP ${r.status}${r.text?`: ${r.text.slice(0,100)}`:''}`);res.json({ok:true,status:r.status,ip,mode:'native-safe',payload,requestedPosition:req.body?.position})}catch(e){res.status(502).json({error:e.message,code:'pipup_send_failed'})}});
 }
 return oldListen.apply(this,args)};
console.log('[ANNOUNCEMENTS] PiPup native-safe bridge v5 ready - web overlay disabled');