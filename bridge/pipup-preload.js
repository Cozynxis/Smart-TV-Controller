const fs=require('fs');
const path=require('path');
const http=require('http');
const express=require('express');
const STORE=path.join(__dirname,'devices.local.json');
function readStore(){try{return JSON.parse(fs.readFileSync(STORE,'utf8'))}catch{return {devices:{}}}}
function resolveTv(body={}){const ds=readStore().devices||{};if(body.ip)return body.ip;if(body.deviceId&&ds[body.deviceId]?.ip)return ds[body.deviceId].ip;const ids=Object.keys(ds);if(ids.length===1)return ds[ids[0]].ip;throw new Error('Geen TV IP gevonden voor announcement.');}
function postJson(ip,endpoint,body,timeout=4500){return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body));const req=http.request({hostname:ip,port:7979,path:endpoint,method:'POST',timeout,headers:{'Content-Type':'application/json','Content-Length':data.length}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode||0,text}))});req.on('timeout',()=>req.destroy(new Error('PiPup timeout')));req.on('error',reject);req.write(data);req.end()})}
const oldListen=express.application.listen;
express.application.listen=function(...args){if(!this.__pipupRoutes){this.__pipupRoutes=true;
 this.post('/api/announcements/test',async(req,res)=>{try{const ip=resolveTv(req.body);const r=await postJson(ip,'/notify',{message:'Smart TV Controller verbonden',duration:3});res.status(r.status>=200&&r.status<300?200:502).json({ok:r.status>=200&&r.status<300,status:r.status,ip})}catch(e){res.status(502).json({error:e.message,code:'pipup_unavailable'})}});
 this.post('/api/announcements/send',async(req,res)=>{try{const ip=resolveTv(req.body),message=String(req.body?.message||'').trim();if(!message)throw new Error('Typ eerst een announcement.');const duration=Math.max(1,Math.min(60,Number(req.body?.duration)||5));const payload={message,duration};if(req.body?.title)payload.title=String(req.body.title).slice(0,80);if(req.body?.position!==undefined)payload.position=Number(req.body.position);if(req.body?.textColor)payload.textColor=String(req.body.textColor);if(req.body?.backgroundColor)payload.backgroundColor=String(req.body.backgroundColor);const r=await postJson(ip,'/notify',payload);if(r.status<200||r.status>=300)throw new Error(`PiPup HTTP ${r.status}${r.text?`: ${r.text.slice(0,100)}`:''}`);res.json({ok:true,status:r.status,ip,duration})}catch(e){res.status(502).json({error:e.message,code:'pipup_send_failed'})}});
 }
 return oldListen.apply(this,args)};
console.log('[ANNOUNCEMENTS] PiPup TV notification bridge ready on port 7979');