const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const rooms = new Map();
const questions = [
  { kind: 'TRIVIA', q: 'Which planet is known as the Red Planet?', options: ['Mars', 'Venus', 'Jupiter', 'Mercury'], answer: 0 },
  { kind: 'TRIVIA', q: 'How many hearts are in a standard deck of cards?', options: ['10', '12', '13', '14'], answer: 2 },
  { kind: 'TRIVIA', q: 'What is the capital of Australia?', options: ['Sydney', 'Canberra', 'Melbourne', 'Perth'], answer: 1 },
  { kind: 'WORD LINK', q: 'Which word best links “moon” and “cheese”?', options: ['Blue', 'Swiss', 'Night', 'Round'], answer: 1 },
  { kind: 'WORD LINK', q: 'Which word best links “card” and “board”?', options: ['Game', 'Paper', 'Table', 'Wood'], answer: 0 },
  { kind: 'TRIVIA', q: 'In a standard deck, which suit is black?', options: ['Hearts', 'Diamonds', 'Clubs', 'Both clubs and spades'], answer: 3 }
];

function code() { let x; do x = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(x)); return x; }
function visible(room, player) {
  return {
    room: room.code, you: player.id, host: room.host, phase: room.phase, level: room.level,
    lives: room.lives, signals: room.signals, score: room.score, maxPlayers: 8,
    players: [...room.players.values()].map(p => ({ id:p.id, name:p.name, connected:p.connected, cardCount:p.hand.length, isHost:p.id===room.host })),
    hand: player.hand, played: room.played, message: room.message, hint: room.hint,
    challenge: room.challenge ? { kind:room.challenge.kind, q:room.challenge.q, options:room.challenge.options, active:room.phase==='challenge', submitted: room.challenge.answers.has(player.id), totalAnswers: room.challenge.answers.size } : null,
    outcome: room.outcome || null
  };
}
function emit(room) { for (const p of room.players.values()) p.res && p.res.write(`data: ${JSON.stringify(visible(room,p))}\n\n`); }
function newRoom(name) {
  const c=code(), id=randomUUID(); const room={code:c,host:id,players:new Map(),phase:'lobby',level:1,lives:3,signals:2,score:0,played:[],message:'Waiting for the host to start.',hint:null,challenge:null,outcome:null};
  room.players.set(id,{id,name,hand:[],connected:true,res:null}); rooms.set(c,room); return {room,id};
}
function deal(room) {
  const deck=Array.from({length:52},(_,i)=>i+1).sort(()=>Math.random()-.5); let i=0;
  for(const p of room.players.values()) p.hand=deck.slice(i,i+=room.level).sort((a,b)=>a-b);
  room.played=[]; room.phase='playing'; room.hint=null; room.challenge=null; room.message=`Level ${room.level}: play your cards in ascending order.`;
}
function finishLevel(room) {
  room.score += room.level*100 + room.lives*25; room.signals=Math.min(3,room.signals+1);
  if(room.level>=6){room.phase='ended';room.outcome='win';room.message='Mind Meld! You cleared all six levels.';return;}
  room.phase='intermission';room.message=`Level ${room.level} cleared! +${room.level*100 + room.lives*25} points. The host can deal Level ${room.level+1}.`;
}
function action(room, id, body) {
  const p=room.players.get(id); if(!p) return;
  if(body.type==='start' && id===room.host && room.phase==='lobby' && room.players.size>=2) deal(room);
  if(body.type==='next' && id===room.host && room.phase==='intermission'){room.level++; deal(room);}
  if(body.type==='restart' && id===room.host && room.phase==='ended'){room.level=1;room.lives=3;room.signals=2;room.score=0;room.outcome=null;deal(room);}
  if(body.type==='play' && room.phase==='playing' && p.hand.includes(body.card)) {
    const lower=[...room.players.values()].flatMap(x=>x.hand).filter(x=>x<body.card);
    p.hand=p.hand.filter(x=>x!==body.card); room.played.push(body.card);
    if(lower.length){ for(const x of room.players.values()) x.hand=x.hand.filter(card=>!lower.includes(card)); room.played.push(...lower); room.played.sort((a,b)=>a-b); room.lives--; room.message=`Too early! ${lower.length} lower card${lower.length>1?'s were':' was'} missed. −1 life.`; }
    else room.message=`${p.name} played ${body.card}. Keep listening.`;
    if(room.lives<=0){room.phase='ended';room.outcome='loss';room.message='Out of lives — the deck got away from you.';}
    else if([...room.players.values()].every(x=>x.hand.length===0)) finishLevel(room);
  }
  if(body.type==='signal' && room.phase==='playing' && room.signals>0) {
    room.signals--; room.phase='challenge'; room.challenge={...questions[Math.floor(Math.random()*questions.length)],answers:new Map()}; room.message='Signal challenge: answer together for a fuzzy hint.';
  }
  if(body.type==='answer' && room.phase==='challenge' && room.challenge && Number.isInteger(body.answer) && body.answer>=0 && body.answer<4) {
    room.challenge.answers.set(id,body.answer);
    if(room.challenge.answers.size===room.players.size){
      const correct=[...room.challenge.answers.values()].filter(x=>x===room.challenge.answer).length;
      if(correct>=Math.ceil(room.players.size/2)){
        const remaining=[...room.players.values()].flatMap(x=>x.hand); const bands=[[1,13],[14,26],[27,39],[40,52]].filter(([a,b])=>remaining.some(x=>x>=a&&x<=b)); const b=bands[Math.floor(Math.random()*bands.length)]; room.hint=`Signal received: at least one remaining card is between ${b[0]}–${b[1]}.`;room.message=`${correct}/${room.players.size} correct — hint unlocked.`;
      } else { room.hint=null;room.message=`Only ${correct}/${room.players.size} correct — no hint this time.`; }
      room.phase='playing'; room.challenge=null;
    }
  }
  emit(room);
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css'};
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(req.method==='POST' && u.pathname==='/api/create'){let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const {name}=JSON.parse(raw||'{}'); if(!name?.trim())return json(res,400,{error:'Name required'}); const {room,id}=newRoom(name.trim().slice(0,18));json(res,200,{code:room.code,id});});return;}
  if(req.method==='POST' && u.pathname==='/api/join'){let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const {code:joinCode,name}=JSON.parse(raw||'{}'),room=rooms.get((joinCode||'').toUpperCase()); if(!room)return json(res,404,{error:'Room not found'}); if(room.phase!=='lobby')return json(res,409,{error:'Game already started'}); if(room.players.size>=8)return json(res,409,{error:'Room is full'}); const id=randomUUID();room.players.set(id,{id,name:(name||'Guest').trim().slice(0,18),hand:[],connected:true,res:null});emit(room);json(res,200,{code:room.code,id});});return;}
  if(req.method==='GET' && u.pathname==='/api/events'){const room=rooms.get(u.searchParams.get('code')),p=room?.players.get(u.searchParams.get('id'));if(!p)return json(res,404,{error:'Unknown player'});res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});p.res=res;p.connected=true;res.write(`data: ${JSON.stringify(visible(room,p))}\n\n`);req.on('close',()=>{if(p.res===res){p.res=null;p.connected=false;emit(room);}});return;}
  if(req.method==='POST' && u.pathname==='/api/action'){let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw||'{}'),room=rooms.get(body.code),p=room?.players.get(body.id);if(!p)return json(res,404,{error:'Unknown player'});action(room,p.id,body);json(res,200,{ok:true});});return;}
  const file=u.pathname==='/'?'public/index.html':path.join('public',u.pathname); if(!file.startsWith('public')||!fs.existsSync(file))return res.writeHead(404).end('Not found');res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain'});fs.createReadStream(file).pipe(res);
});
server.listen(process.env.PORT||3000,()=>console.log('Signal Deck running on http://localhost:3000'));
