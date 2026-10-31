import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, startHand, act, setQueued, legalActions, settle } from '../src/game/holdem.js';
import { normalizeGameFormat } from '../src/game/format.js';
import { addPlayer, createRoom } from '../src/game/room.js';
import { migrateRoom } from '../src/game/migrations.js';
import { publicRoom } from '../src/game/view.js';
import { shuffledDeck } from '../src/platform/random.js';

const c = (rank, suit = 0) => suit * 13 + rank - 2;
const TEST_DECK = Array.from({ length: 52 }, (_, index) => 51 - index);
const shuffledTestDeck = () => { let seed = 123456789; return shuffledDeck(() => (seed = (seed * 1664525 + 1013904223) >>> 0)); };
function testRoom(id, host, name, { buyIn = 2000, maxPlayers = 9, small = 10, big = 20 } = {}) {
  const room = createRoom(id, host, name, { mode: 'ring' });
  room.format = { ...room.format, buyIn, maxPlayers, blinds: { small, big }, rebuy: { enabled: true, amount: buyIn } };
  room.minRaise = big;
  return room;
}
function setup(stacks = [2000, 2000]) {
  let room = testRoom('test', 'p0', '테스트');
  stacks.forEach((chips, i) => { room = addPlayer(room, 'p' + i, '친구' + i); room.players[i].chips = chips; room.players[i].ready = true; });
  return startHand(room, 'p0', TEST_DECK, 0);
}

test('링게임은 10,000칩, 블라인드 100/200의 50BB로 최대 6명까지 입장한다', () => {
  let room = createRoom('capacity', 'p0', '정원 검증', { mode: 'ring' });
  for (let index = 0; index < 6; index++) room = addPlayer(room, `p${index}`, `참가자${index}`);
  assert.equal(room.players.length, 6);
  assert.ok(room.players.every(player => player.chips === 10000));
  assert.deepEqual([room.format.blinds.small, room.format.blinds.big, room.minRaise], [100, 200, 200]);
  assert.throws(() => room = addPlayer(room, 'p6', '일곱 번째 참가자'), /정원이 가득/);
  assert.equal(room.players.length, 6);
  assert.equal(room.records.p6, undefined);
});
test('게임 규격은 고정되고 상태 전이는 입력을 바꾸지 않는다', () => {
  const ring = normalizeGameFormat({ mode: 'ring', buyIn: 5000, maxPlayers: 9 });
  const tournament = normalizeGameFormat({ mode: 'tournament', tournamentSpeed: 'turbo', maxPlayers: 2 });
  assert.deepEqual([ring.buyIn, ring.maxPlayers, ring.blinds.small, ring.blinds.big], [10000, 6, 100, 200]);
  assert.deepEqual([tournament.buyIn, tournament.maxPlayers, tournament.blinds.small, tournament.blinds.big], [10000, 9, 25, 50]);
  assert.throws(() => normalizeGameFormat({ mode: 'private' }), /링게임 또는 토너먼트/);
  let room = testRoom('custom', 'p0', '엔진 검증', { buyIn: 5000, maxPlayers: 2, small: 25, big: 50 });
  room = addPlayer(room, 'p0', '가');
  room = addPlayer(room, 'p1', '나');
  assert.deepEqual(room.players.map(player => player.chips), [5000, 5000]);
  assert.throws(() => addPlayer(room, 'p2', '다'), /정원이 가득/);
  room.players.forEach(player => { player.ready = true; });
  const started = startHand(room, 'p0', TEST_DECK, 1000);
  assert.equal(room.stage, 'waiting');
  assert.deepEqual(room.board, []);
  assert.equal(started.stage, 'preflop');
  assert.equal(started.deadline, 21000);
  assert.equal(room.format.blinds.big, 50);
});
test('덱은 중복 없이 52장을 포함한다', () => {
  const deck = shuffledTestDeck(); assert.equal(new Set(deck).size, 52); assert.ok(deck.every(c => c >= 0 && c < 52));
});
test('족보 순위, 휠 스트레이트, 두 트리플의 풀 하우스', () => {
  const royal = evaluate([10,11,12,13,14].map(r => c(r)));
  assert.equal(royal.name, '로열 플러시');
  const wheel = evaluate([c(14), c(2,1), c(3,2), c(4,3), c(5), c(9), c(10,2)]);
  assert.equal(wheel.name, '스트레이트');
  assert.ok(evaluate([c(2), c(3,1), c(4,2), c(5,3), c(6)]).score > wheel.score);
  assert.equal(evaluate([c(14),c(14,1),c(14,2),c(13),c(13,1),c(13,2),c(2)]).name,'풀 하우스');
  assert.ok(royal.score > evaluate([c(14),c(14,1),c(14,2),c(14,3),c(13)]).score);
});
test('같은 족보의 킥커와 보드 공유 무승부', () => {
  const board = [c(2),c(2,1),c(5,2),c(8,3),c(10)];
  assert.ok(evaluate([...board,c(14,2),c(3)]).score > evaluate([...board,c(13,2),c(3)]).score);
  const royal = [10,11,12,13,14].map(r => c(r));
  assert.equal(evaluate([...royal,c(2,1),c(3,1)]).score, evaluate([...royal,c(8,2),c(9,2)]).score);
});
test('헤즈업 딜러는 스몰 블라인드이며 프리플롭 먼저 행동한다', () => {
  let room = setup(); assert.equal(room.dealer, room.sb); assert.equal(room.turn, room.sb);
  room = act(room, room.players[room.turn].id, 'call');
  assert.equal(room.turn, room.bb); assert.ok(legalActions(room,room.players[room.turn].id).canCheck);
  room = act(room, room.players[room.turn].id, 'check');
  assert.equal(room.stage, 'flop'); assert.equal(room.turn, room.bb); assert.equal(room.board.length,3);
});
test('차례, 체크, 레이즈 금액 검증 및 개인 패 비공개', () => {
  let room = setup();
  assert.throws(() => room = act(room,'p1','check'), /차례/);
  assert.throws(() => room = act(room,'p0','check'), /콜/);
  assert.throws(() => room = act(room,'p0','raise',21), /범위/);
  assert.throws(() => room = act(room,'p0','raise',NaN), /범위/);
  const state = publicRoom(room, 'p0');
  assert.equal(state.players[0].cards.length,2); assert.ok(state.players[0].cards.every(Number.isInteger));
  assert.deepEqual(state.players[1].cards,[null,null]);
  assert.equal(state.deck,undefined); assert.equal(state.records,undefined);
});
test('체크와 콜로 쇼다운까지 진행하고 전적은 한 번 정산한다', () => {
  let room = setup([2000,2000,2000]);
  let count = 0;
  while(room.stage !== 'finished' && count++ < 30) {
    const id = room.players[room.turn].id; const legal = legalActions(room,id);
    room = act(room,id,legal.canCheck ? 'check' : 'call');
  }
  assert.equal(room.stage,'finished'); assert.equal(room.board.length,5);
  assert.equal(room.players.reduce((sum,p)=>sum+p.chips,0),6000);
  assert.equal(room.history.length,1);
  assert.throws(()=>room = act(room,'p0','call'));
});
test('쇼다운 전에 모두 폴드하면 승자의 패를 공개하지 않는다', () => {
  let room = setup(); room = act(room,'p0','fold');
  assert.equal(room.stage,'finished'); assert.equal(room.players[1].chips,2010);
  assert.deepEqual(publicRoom(room, 'p0').players[1].cards, [null, null]);
});
test('짧은 올인은 이미 행동한 플레이어의 레이즈 권한을 열지 않는다', () => {
  let room = setup([2000,30,2000]);
  assert.equal(room.turn,0); room = act(room,'p0','call');
  room = act(room,'p1','raise',30); room = act(room,'p2','call');
  assert.equal(room.turn,0); assert.equal(legalActions(room,'p0').canRaise,false);
  assert.throws(()=>room = act(room,'p0','raise',50),/범위/);
  room = act(room,'p0','call'); assert.equal(room.stage,'flop');
});
test('여러 짧은 올인의 누적 상승이 정규 레이즈 크기를 채우면 다시 레이즈할 수 있다', () => {
  let room = setup([2000,2000,2000,2000]);
  room.stage='flop'; room.bet=100; room.minRaise=100; room.turn=1;
  for (const p of room.players) { p.bet=100; p.total=100; p.actedAt=100; }
  room.players[1].chips=50; room.players[1].actedAt=null;
  room.players[2].chips=100; room.players[2].actedAt=null;
  room = act(room,'p1','raise',150); room = act(room,'p2','raise',200);
  assert.equal(legalActions(room,'p3').canRaise,true);
});
test('사이드 팟과 미콜 초과 금액을 정확히 나눈다', () => {
  let room = setup([100,200,500]);
  room.board=[c(2),c(5,1),c(8,2),c(10,3),c(3)];
  const totals=[100,200,300];
  room.players.forEach((p,i)=>{p.total=totals[i];p.chips=i===2?200:0;p.startChips=[100,200,500][i];p.cards=[c(14-i,1),c(14-i,2)];});
  room.pot=600; room = settle(room,true);
  assert.deepEqual(room.players.map(p=>p.chips),[300,200,300]);
});
test('나눌 수 없는 홀수 칩은 딜러 왼쪽 승자부터 분배한다', () => {
  let room=setup([100,100,100]);
  room.board=[10,11,12,13,14].map(r=>c(r)); room.dealer=0;
  room.players.forEach(p=>{p.total=5;p.chips=95;p.startChips=100;});
  room.players[2].folded=true; room.pot=15;
  room = settle(room,true); assert.deepEqual(room.players.map(p=>p.chips),[102,103,95]);
});
test('빅 블라인드보다 작은 올인도 자동 진행 후 정산된다', () => {
  let room=setup([5,10]); assert.equal(room.stage,'finished');
  assert.equal(room.players.reduce((sum,p)=>sum+p.chips,0),15);
});
test('헤즈업에서 빅 블라인드가 짧게 올인하면 초과 콜을 요구하지 않는다', () => {
  let room=setup([2000,5]); assert.equal(room.stage,'finished');
  assert.equal(room.players.reduce((sum,p)=>sum+p.chips,0),2005);
});
test('500개 무작위 핸드에서 칩 보존, 유효 차례, 종료를 유지한다', () => {
  let seed=93280;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};
  for(let n=0;n<500;n++){
    const stacks=Array.from({length:2+Math.floor(random()*5)},()=>1+Math.floor(random()*2000));
    const total=stacks.reduce((a,b)=>a+b,0); let room=setup(stacks); let count=0;
    while(room.stage!=='finished' && count++<300){
      const p=room.players[room.turn]; assert.ok(p && !p.folded && p.chips>0);
      const legal=legalActions(room,p.id);const r=random();
      if(r<.14)room = act(room,p.id,'fold');
      else if(r<.35 && legal.canRaise)room = act(room,p.id,'raise',r<.21?legal.max:legal.min);
      else room = act(room,p.id,legal.canCheck?'check':'call');
      assert.equal(room.players.reduce((s,p)=>s+p.chips,room.pot),total);
      assert.ok(room.players.every(p=>Number.isSafeInteger(p.chips)&&p.chips>=0));
    }
    assert.equal(room.stage,'finished');
  }
});
test('예약 체크/폴드는 차례가 오면 체크하고, 베팅이 있으면 폴드한다', () => {
  let room = setup([2000,2000,2000]);
  // p0 acts first preflop; the big blind (p2) can still check after calls.
  room = setQueued(room,'p2',{ type:'checkFold' });
  assert.equal(publicRoom(room, 'p2').queued.type, 'checkFold');
  assert.equal(publicRoom(room, 'p0').queued, null);
  room = act(room,'p0','call'); room = act(room,'p1','call');
  assert.equal(room.stage,'flop'); assert.equal(room.players[2].lastAction,'');
  assert.equal(room.actions.at(-1).text,'체크');
  // Flop: p1 acts first. p2 queues check/fold, then p1 bets, so p2 folds automatically.
  room = setQueued(room,'p2',{ type:'checkFold' });
  room = act(room,'p1','raise',100);
  assert.equal(room.players[2].folded,true);
  assert.equal(room.players[2].queued,undefined);
});
test('예약 체크는 베팅이 생기면 실행되지 않고, 예약 콜은 상한을 넘으면 취소된다', () => {
  let room = setup([2000,2000,2000]);
  room = setQueued(room,'p1',{ type:'call' });
  assert.equal(room.players[1].queued.cap,10);
  room = act(room,'p0','raise',60);
  assert.equal(room.turn,1); assert.equal(room.players[1].queued,undefined);
  assert.equal(room.players[1].folded,false);
  room = act(room,'p1','call');
  room = setQueued(room,'p0',{ type:'check' });
  room = act(room,'p2','call');
  assert.equal(room.stage,'flop');
  assert.equal(room.players[0].queued,undefined, '라운드가 끝나면 예약이 사라진다');
});
test('예약 콜은 금액이 같으면 실행되고, 내 차례나 잘못된 예약은 거부한다', () => {
  let room = setup([2000,2000,2000]);
  assert.throws(()=>room = setQueued(room,'p0',{ type:'fold' }),/내 차례/);
  assert.throws(()=>room = setQueued(room,'p2',{ type:'call' }),/맞출 베팅/);
  assert.throws(()=>room = setQueued(room,'p1',{ type:'check' }),/체크/);
  assert.throws(()=>room = setQueued(room,'p1',{ type:'allin' }),/확인/);
  room = setQueued(room,'p2',{ type:'fold' }); room = setQueued(room,'p2',null);
  assert.equal(room.players[2].queued,undefined);
  room = setQueued(room,'p1',{ type:'call' });
  room = act(room,'p0','call');
  assert.equal(room.players[1].lastAction,'콜 10');
  assert.equal(room.turn,2);
});
test('핸드 기록은 행동, 기여, 종료 칩, 환급을 남기고 비공개 패를 숨긴다', () => {
  let room = setup([2000,2000]);
  room = act(room,'p0','raise',500); room = act(room,'p1','fold');
  const hand = room.history[0];
  assert.deepEqual(hand.actions.map(a => a.text),['스몰 블라인드 10','빅 블라인드 20','레이즈 500','폴드']);
  const p0 = hand.players.find(p => p.id === 'p0');
  assert.equal(p0.contributed,500); assert.equal(p0.refund,480); assert.equal(p0.won,40); assert.equal(p0.end,2020);
  const view = publicRoom(room, 'p1').history[0].players;
  assert.ok(view.find(p => p.id === 'p1').cards.every(Number.isInteger), '내 폴드 패는 나에게 보인다');
  assert.equal(view.find(p => p.id === 'p0').cards,null);
});
test('환급만 받은 플레이어는 승수에 포함하지 않고 기록은 50핸드까지 보관한다', () => {
  let room = setup([2000,2000]);
  room.board=[c(2),c(5,1),c(8,2),c(10,3),c(3)];
  room.players.forEach((p,i)=>{p.total=i?1000:300;p.chips=2000-p.total;p.startChips=2000;p.cards=i?[c(4),c(4,1)]:[c(14),c(14,1)];});
  room.pot=1300; room = settle(room,true);
  assert.equal(room.history[0].players[1].refund,700);
  for (let i = 0; i < 60; i++) { room.players.forEach(p => { p.ready = true; p.chips = 2000; }); room = startHand(room, room.hostId, TEST_DECK, 0); room = act(room,room.players[room.turn].id,'fold'); }
  assert.equal(room.history.length,50);
});

test('오래된 비공개 테이블 데이터는 저장값을 바꾸지 않고 게임 진입을 막는다', () => {
  const older = { id: 'older', format: { mode: 'private', buyIn: 20000 }, players: [{ id: 'p0', chips: 20000 }] };
  const migrated = migrateRoom(older);
  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.room, older);
});
