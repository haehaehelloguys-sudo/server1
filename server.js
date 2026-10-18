'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.ANF_RELAY_TOKEN || '';
const MAX_BODY = 1024 * 1024;
const MAX_EVENTS = 4096;
const rooms = new Map();
function send(res, code, obj, type='application/json; charset=utf-8') {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, {'Content-Type':type,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'}); res.end(body);
}
function validRoom(s){ return typeof s==='string' && /^[a-zA-Z0-9_-]{1,48}$/.test(s); }
function cleanData(d){
  if(!d || typeof d!=='object') return null;
  const n=(x)=>Number.isFinite(Number(x))?Number(x):0;
  const str=(x,max)=>String(x==null?'':x).slice(0,max);
  const keyEvents=Array.isArray(d.keyEvents)?d.keyEvents.slice(-MAX_EVENTS).filter(e=>e&&typeof e==='object'&&Number.isFinite(Number(e.id))&&typeof e.key==='string'&&e.key.length<=24).map(e=>({id:Number(e.id),session:String(e.session||'default').slice(0,64),key:e.key,down:!!e.down,t:n(e.t)})) : [];
  return {seq:n(d.seq),t:n(d.t),ok:!!d.ok,countsOk:!!d.countsOk,status:str(d.status||'unknown',24),name:str(d.name||'ANF Player',24),avatarUrl:typeof d.avatarUrl==='string' && /^https?:\/\//i.test(d.avatarUrl) ? d.avatarUrl.slice(0,1000) : '',acc:n(d.acc),perfect:n(d.perfect),early:n(d.early),late:n(d.late),miss:n(d.miss),overload:n(d.overload),rawCounts:Array.isArray(d.rawCounts)?d.rawCounts.slice(0,16).map(n):[],keys:Array.isArray(d.keys)?d.keys.filter(k=>typeof k==='string'&&k.length<=24).slice(0,16):[],keyConfig:Array.isArray(d.keyConfig)?d.keyConfig.filter(k=>typeof k==='string'&&k.length<=24).slice(0,16):[],keyEvents,receivedAt:Date.now()};
}
function newRoom(){return {A:null,B:null,events:{A:[],B:[]},seen:{A:new Set(),B:new Set()},seenOrder:{A:[],B:[]},eventCounters:{A:0,B:0}};}
function getRoom(code){if(!rooms.has(code))rooms.set(code,newRoom());return rooms.get(code);}
function ingestEvents(room,slot,incoming){
  for(const ev of incoming||[]){
    const identity=String(ev.session||'default')+':'+String(ev.id);
    if(room.seen[slot].has(identity)) continue;
    room.seen[slot].add(identity);room.seenOrder[slot].push(identity);
    if(room.seenOrder[slot].length>MAX_EVENTS*2){const old=room.seenOrder[slot].shift();room.seen[slot].delete(old);}
    room.events[slot].push({eid:++room.eventCounters[slot],key:ev.key,down:ev.down,t:ev.t});
    if(room.events[slot].length>MAX_EVENTS)room.events[slot].splice(0,room.events[slot].length-MAX_EVENTS);
  }
}
function handler(req,res){
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-ANF-Token'});return res.end();}
  let u;try{u=new URL(req.url,'http://localhost');}catch(e){return send(res,400,{ok:false,error:'invalid_url'});}
  if(req.method==='GET' && u.pathname==='/health') return send(res,200,{ok:true,service:'ANFOverlay relay',time:Date.now()});
  if(req.method==='GET' && u.pathname==='/overlay'){
    try {const file=path.join(__dirname,'overlay.html');return send(res,200,fs.readFileSync(file,'utf8'),'text/html; charset=utf-8');}
    catch(e){return send(res,500,{ok:false,error:'overlay_unavailable'});}
  }
  if(req.method==='POST' && u.pathname==='/api/state'){
    if(!TOKEN || req.headers['x-anf-token']!==TOKEN) return send(res,401,{ok:false,error:'unauthorized'});
    let body='',finished=false;
    req.on('data',chunk=>{if(finished)return;body+=chunk.toString('utf8');if(Buffer.byteLength(body,'utf8')>MAX_BODY){finished=true;send(res,413,{ok:false,error:'too_large'});req.destroy();}});
    req.on('end',()=>{if(finished)return;try{
      const x=JSON.parse(body);if(!validRoom(x.room))return send(res,400,{ok:false,error:'invalid_room'});
      if(x.slot!=='A'&&x.slot!=='B')return send(res,400,{ok:false,error:'invalid_slot'});
      const data=cleanData(x.data);if(!data)return send(res,400,{ok:false,error:'invalid_data'});
      const r=getRoom(x.room);r[x.slot]=data;ingestEvents(r,x.slot,data.keyEvents);
      return send(res,200,{ok:true,room:x.room,slot:x.slot,receivedAt:data.receivedAt});
    }catch(e){return send(res,400,{ok:false,error:'invalid_json'});}});return;
  }
  if(req.method==='GET' && u.pathname==='/api/state'){
    const roomCode=u.searchParams.get('room')||'';if(!validRoom(roomCode))return send(res,400,{ok:false,error:'invalid_room'});
    const r=rooms.get(roomCode)||newRoom(),now=Date.now();
    const player=(p)=>p?Object.assign({},p,{stale:now-p.receivedAt>5000,keyEvents:undefined}):null;
    return send(res,200,{ok:true,room:roomCode,players:{A:player(r.A),B:player(r.B)},serverTime:now});
  }
  if(req.method==='GET' && u.pathname==='/api/events'){
    const roomCode=u.searchParams.get('room')||'',slot=u.searchParams.get('player')||'',after=Math.max(0,Number(u.searchParams.get('after')||0));
    if(!validRoom(roomCode))return send(res,400,{ok:false,error:'invalid_room'});
    if(slot!=='A'&&slot!=='B')return send(res,400,{ok:false,error:'invalid_slot'});
    const r=rooms.get(roomCode)||newRoom(),list=r.events[slot],oldest=list.length?list[0].eid:r.eventCounters[slot]+1;
    const reset=after>0&&after<oldest-1;
    return send(res,200,{ok:true,events:list.filter(e=>e.eid>after),latestEventId:r.eventCounters[slot],oldestEventId:oldest,reset});
  }
  return send(res,404,{ok:false,error:'not_found'});
}
if(require.main===module){
 if(!TOKEN)console.warn('WARNING: ANF_RELAY_TOKEN is not set; POST /api/state will reject all uploads.');
 http.createServer(handler).listen(PORT,'0.0.0.0',()=>console.log(`ANFOverlay relay listening on 0.0.0.0:${PORT}`));
}
module.exports={handler,cleanData,validRoom};
