const fs=require('fs');
const path=require('path');
const express=require('express');

const originalStatic=express.static;
express.static=function(root,options){
  const mw=originalStatic(root,options);
  return function(req,res,next){
    if(req.method==='GET'&&(req.path==='/'||req.path==='/index.html')){
      try{
        let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
        html=html.replace(/<link[^>]+animation-creator\.css[^>]*>\s*/g,'').replace(/<script[^>]+animation-creator\.js[^>]*><\/script>\s*/g,'');
        html=html.replace('</head>','  <link rel="stylesheet" href="css/animation-creator.css?v=3" />\n</head>');
        html=html.replace('</body>','<script src="js/animation-creator.js?v=3"></script>\n</body>');
        res.type('html');res.set('Cache-Control','no-store, no-cache, must-revalidate');res.set('Pragma','no-cache');res.send(html);return;
      }catch(e){console.error('[CREATOR] dashboard injection failed:',e.message)}
    }
    mw(req,res,next)
  }
};
console.log('[AMBI] Simple Animation Maker dashboard assets enabled');