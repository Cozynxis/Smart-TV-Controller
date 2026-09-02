const fs=require('fs');
const path=require('path');
const express=require('express');

// Inject creator assets into the locally served dashboard without changing pairing logic.
const originalStatic=express.static;
express.static=function(root,options){
  const mw=originalStatic(root,options);
  return function(req,res,next){
    if(req.method==='GET'&&(req.path==='/'||req.path==='/index.html')){
      try{
        let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
        if(!html.includes('animation-creator.css'))html=html.replace('</head>','  <link rel="stylesheet" href="css/animation-creator.css" />\n</head>');
        if(!html.includes('animation-creator.js'))html=html.replace('</body>','<script src="js/animation-creator.js"></script>\n</body>');
        res.type('html').set('Cache-Control','no-store').send(html);return;
      }catch{}
    }
    mw(req,res,next)
  }
};

// When the normal animation Stop button is used, stop a custom timeline as well.
const originalPost=express.application.post;
express.application.post=function(pathName,...handlers){
  if(pathName==='/api/ambilight/animation/stop'){
    const wrapped=handlers.map((handler,index)=>index?handler:async function(req,res,next){
      try{fetch('http://127.0.0.1:8765/api/ambilight/custom/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:req.body?.deviceId}),signal:AbortSignal.timeout(700)}).catch(()=>{})}catch{}
      return handler(req,res,next)
    });
    return originalPost.call(this,pathName,...wrapped)
  }
  return originalPost.call(this,pathName,...handlers)
};
console.log('[AMBI] Animation Creator dashboard integration preloaded');