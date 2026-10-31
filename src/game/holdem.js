import { TOURNAMENT_LEVELS } from './format.js';

export const HAND_NAMES = ['하이 카드', '원 페어', '투 페어', '트리플', '스트레이트', '플러시', '풀 하우스', '포 카드', '스트레이트 플러시'];
export const HISTORY_LIMIT = 50;

export function evaluate(cards) {
  const ranks = cards.map(c => c % 13 + 2).sort((a, b) => b - a);
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const straight = values => {
    const unique = [...new Set(values)].sort((a, b) => b - a);
    if (unique.includes(14)) unique.push(1);
    for (let i = 0; i <= unique.length - 5; i++) if (unique[i] - unique[i + 4] === 4) return unique[i];
    return 0;
  };
  const flush = [0, 1, 2, 3].map(s => cards.filter(c => Math.floor(c / 13) === s).map(c => c % 13 + 2).sort((a, b) => b - a)).find(v => v.length >= 5);
  let result;
  if (flush && straight(flush)) result = [8, straight(flush)];
  else if (groups[0][1] === 4) result = [7, groups[0][0], ...ranks.filter(r => r !== groups[0][0]).slice(0, 1)];
  else if (groups[0][1] >= 3 && groups[1]?.[1] >= 2) result = [6, groups[0][0], groups[1][0]];
  else if (flush) result = [5, ...flush.slice(0, 5)];
  else if (straight(ranks)) result = [4, straight(ranks)];
  else if (groups[0][1] === 3) result = [3, groups[0][0], ...ranks.filter(r => r !== groups[0][0]).slice(0, 2)];
  else if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a, b) => b - a).slice(0, 2);
    result = [2, ...pairs, ...ranks.filter(r => !pairs.includes(r)).slice(0, 1)];
  } else if (groups[0][1] === 2) result = [1, groups[0][0], ...ranks.filter(r => r !== groups[0][0]).slice(0, 3)];
  else result = [0, ...ranks.slice(0, 5)];
  while (result.length < 6) result.push(0);
  return { score: result.reduce((v, r) => v * 15 + r, 0), name: result[0] === 8 && result[1] === 14 ? '로열 플러시' : HAND_NAMES[result[0]] };
}

const copy = state => structuredClone(state);
const playing = player => player.active && !player.folded;
const canAct = player => playing(player) && player.chips > 0;

function log(room, message) {
  room.log.unshift(message);
  room.log = room.log.slice(0, 35);
}

function next(room, from, predicate) {
  for (let distance = 1; distance <= room.players.length; distance++) {
    const index = (from + distance + room.players.length) % room.players.length;
    if (predicate(room.players[index])) return index;
  }
  return -1;
}

function pay(room, player, amount) {
  const value = Math.min(amount, player.chips);
  player.chips -= value;
  player.bet += value;
  player.total += value;
  room.pot += value;
}

function payAnte(room, player, amount) {
  const value = Math.min(amount, player.chips);
  player.chips -= value;
  player.total += value;
  room.pot += value;
  return value;
}

function setTurn(room, index, now) {
  room.turn = index;
  room.deadline = index < 0 ? null : now + room.format.turnTimeoutMs;
}

export function legalActions(room, id) {
  const player = room.players[room.turn];
  if (!player || player.id !== id || !canAct(player)) return null;
  const toCall = Math.max(0, room.bet - player.bet);
  const reopened = player.actedAt === null || room.bet - player.actedAt >= room.minRaise;
  const opponents = room.players.filter(other => other.id !== id && canAct(other));
  return {
    toCall: Math.min(toCall, player.chips),
    canCheck: toCall === 0,
    canRaise: reopened && opponents.length > 0 && player.chips > toCall,
    min: Math.min(room.bet + room.minRaise, player.bet + player.chips),
    max: player.bet + player.chips,
  };
}

export function startHand(room, id, deck, now = 0) {
  if (!Array.isArray(deck) || deck.length !== 52 || new Set(deck).size !== 52 || deck.some(card => !Number.isInteger(card) || card < 0 || card > 51)) {
    throw new Error('덱 상태가 올바르지 않습니다.');
  }
  const nextRoom = copy(room);
  startHandInPlace(nextRoom, id, deck, now);
  return nextRoom;
}

function startHandInPlace(room, id, deck, now) {
  if (id !== room.hostId) throw new Error('방장만 핸드를 시작할 수 있습니다.');
  if (!['waiting', 'finished'].includes(room.stage)) throw new Error('이미 핸드가 진행 중입니다.');
  if (room.tournament?.winnerId) throw new Error('토너먼트가 종료됐습니다.');
  const participants = room.players.filter(player => player.ready && player.chips > 0);
  if (participants.length < 2) throw new Error('최소 2명이 준비해야 합니다.');
  if (room.tournament && room.tournament.startedAt === null) {
    room.tournament.startedAt = now;
    room.tournament.nextLevelAt = now + (room.format.tournamentSpeed === 'turbo' ? 3 : 6) * 60 * 1000;
  }
  const level = room.tournament ? TOURNAMENT_LEVELS[room.tournament.level - 1] : null;
  const blinds = level ? { small: level.small, big: level.big } : room.format.blinds;
  const ante = level?.ante || 0;
  room.handBlinds = blinds;
  room.handAnte = ante;
  if (room.tournament) room.handLevel = room.tournament.level;
  room.deck = [...deck];
  room.board = [];
  room.result = [];
  room.nextHandAt = null;
  room.pot = 0;
  room.hand++;
  room.stage = 'preflop';
  room.bet = blinds.big;
  room.minRaise = blinds.big;
  for (const player of room.players) {
    player.active = participants.includes(player);
    player.folded = !player.active;
    player.cards = [];
    player.bet = 0;
    player.total = 0;
    player.actedAt = null;
    player.startChips = player.chips;
    player.lastAction = player.active ? '' : '쉬는 중';
    if (player.active) player.cards = [room.deck.pop(), room.deck.pop()];
  }
  for (const player of room.players) delete player.queued;
  room.dealer = next(room, room.dealer, player => player.active);
  room.sb = participants.length === 2 ? room.dealer : next(room, room.dealer, player => player.active);
  room.bb = next(room, room.sb, player => player.active);
  room.actions = [];
  if (ante) for (const player of participants) room.actions.push({ stage: 'preflop', name: player.name, text: '앤티 ' + payAnte(room, player, ante) });
  pay(room, room.players[room.sb], blinds.small);
  pay(room, room.players[room.bb], blinds.big);
  room.actions.push(
    { stage: 'preflop', name: room.players[room.sb].name, text: '스몰 블라인드 ' + room.players[room.sb].bet },
    { stage: 'preflop', name: room.players[room.bb].name, text: '빅 블라인드 ' + room.players[room.bb].bet },
  );
  log(room, '핸드 #' + room.hand + ' 시작. 블라인드 ' + blinds.small + ' / ' + blinds.big + (ante ? ' · 앤티 ' + ante : ''));
  progress(room, room.bb, now);
}

export function act(room, id, action, amount, now = 0) {
  const nextRoom = copy(room);
  actInPlace(nextRoom, id, action, amount, now);
  return nextRoom;
}

function actInPlace(room, id, action, amount, now) {
  const player = room.players[room.turn];
  if (!player || player.id !== id || !canAct(player)) throw new Error('지금은 내 차례가 아닙니다.');
  const legal = legalActions(room, id);
  if (action === 'fold') {
    player.folded = true;
    player.lastAction = '폴드';
  } else if (action === 'check') {
    if (!legal.canCheck) throw new Error('콜 또는 폴드를 선택해 주세요.');
    player.lastAction = '체크';
  } else if (action === 'call') {
    if (legal.canCheck) throw new Error('체크할 수 있습니다.');
    pay(room, player, legal.toCall);
    player.lastAction = player.chips === 0 ? '올인' : '콜 ' + legal.toCall;
  } else if (action === 'raise') {
    if (!legal.canRaise || !Number.isSafeInteger(amount) || amount < legal.min || amount > legal.max) throw new Error('가능한 레이즈 범위를 확인해 주세요.');
    const raiseSize = amount - room.bet;
    pay(room, player, amount - player.bet);
    room.bet = amount;
    if (raiseSize >= room.minRaise) room.minRaise = raiseSize;
    player.lastAction = player.chips === 0 ? '올인' : '레이즈 ' + amount;
  } else throw new Error('알 수 없는 행동입니다.');
  player.actedAt = room.bet;
  delete player.queued;
  room.actions?.push({ stage: room.stage, name: player.name, text: player.lastAction });
  log(room, player.name + ': ' + player.lastAction);
  progress(room, room.turn, now);
}

export const QUEUE_TYPES = ['fold', 'checkFold', 'check', 'call'];

export function setQueued(room, id, queued) {
  const nextRoom = copy(room);
  setQueuedInPlace(nextRoom, id, queued);
  return nextRoom;
}

function setQueuedInPlace(room, id, queued) {
  const player = room.players.find(entry => entry.id === id);
  if (!player || !canAct(player) || ['waiting', 'finished'].includes(room.stage)) throw new Error('진행 중인 핸드에 참여할 때만 미리 선택할 수 있습니다.');
  if (room.players[room.turn] === player) throw new Error('지금 내 차례예요. 바로 행동해 주세요.');
  if (queued === null) {
    delete player.queued;
    return;
  }
  if (!QUEUE_TYPES.includes(queued?.type)) throw new Error('미리 선택할 행동을 확인해 주세요.');
  const toCall = Math.min(Math.max(0, room.bet - player.bet), player.chips);
  if (queued.type === 'check' && toCall > 0) throw new Error('맞춰야 할 베팅이 있어 체크를 미리 선택할 수 없습니다.');
  if (queued.type === 'call' && toCall === 0) throw new Error('맞출 베팅이 없어요. 체크를 선택해 주세요.');
  player.queued = { type: queued.type, stage: room.stage, ...(queued.type === 'call' ? { cap: toCall } : {}) };
}

function queuedAction(room, player) {
  const legal = legalActions(room, player.id);
  const { type, cap } = player.queued;
  if (type === 'fold') return 'fold';
  if (type === 'checkFold') return legal.canCheck ? 'check' : 'fold';
  if (type === 'check') return legal.canCheck ? 'check' : null;
  return !legal.canCheck && legal.toCall <= cap ? 'call' : null;
}

function progress(room, from, now) {
  const live = room.players.filter(playing);
  if (live.length === 1) {
    settleInPlace(room, false, now);
    return;
  }
  const actors = room.players.filter(canAct);
  if (actors.length === 1) room.bet = Math.max(...live.map(player => player.bet));
  const needsAction = player => canAct(player) && (player.bet < room.bet || (player.actedAt === null && actors.length > 1));
  const turn = next(room, from, needsAction);
  if (turn !== -1) {
    setTurn(room, turn, now);
    const player = room.players[turn];
    if (player.queued) {
      const action = queuedAction(room, player);
      delete player.queued;
      if (action) actInPlace(room, player.id, action, undefined, now);
    }
    return;
  }
  if (room.stage === 'river') {
    settleInPlace(room, true, now);
    return;
  }
  const nextStage = { preflop: 'flop', flop: 'turn', turn: 'river' }[room.stage];
  room.stage = nextStage;
  room.deck.pop();
  for (let i = 0; i < (nextStage === 'flop' ? 3 : 1); i++) room.board.push(room.deck.pop());
  room.bet = 0;
  room.minRaise = (room.handBlinds || room.format.blinds).big;
  for (const player of room.players) {
    player.bet = 0;
    player.actedAt = null;
    delete player.queued;
    if (canAct(player)) player.lastAction = '';
  }
  log(room, { flop: '플롭', turn: '턴', river: '리버' }[nextStage] + ' 공개');
  progress(room, room.dealer, now);
}

export function settle(room, showdown, now = 0) {
  const nextRoom = copy(room);
  settleInPlace(nextRoom, showdown, now);
  return nextRoom;
}

function settleInPlace(room, showdown, now) {
  const live = room.players.filter(playing);
  const awards = new Map();
  const refunds = new Map();
  const ranks = new Map(live.map(player => [player.id, showdown ? evaluate([...player.cards, ...room.board]) : { score: 0, name: '모두 폴드' }]));
  const levels = [...new Set(room.players.map(player => player.total).filter(Boolean))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const contributors = room.players.filter(player => player.total >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (contributors.length === 1) {
      contributors[0].chips += amount;
      refunds.set(contributors[0].id, (refunds.get(contributors[0].id) || 0) + amount);
      continue;
    }
    const eligible = live.filter(player => player.total >= level);
    if (!eligible.length) throw new Error('팟 정산 상태가 올바르지 않습니다.');
    const best = Math.max(...eligible.map(player => ranks.get(player.id).score));
    const winners = eligible.filter(player => ranks.get(player.id).score === best);
    winners.sort((a, b) => ((room.players.indexOf(a) - room.dealer - 1 + room.players.length) % room.players.length) - ((room.players.indexOf(b) - room.dealer - 1 + room.players.length) % room.players.length));
    winners.forEach((player, index) => {
      const share = Math.floor(amount / winners.length) + (index < amount % winners.length ? 1 : 0);
      player.chips += share;
      awards.set(player.id, (awards.get(player.id) || 0) + share);
    });
  }
  room.result = [...awards].map(([id, amount]) => ({ id, name: room.players.find(player => player.id === id).name, amount, handName: ranks.get(id).name }));
  for (const player of room.players.filter(entry => entry.active)) {
    player.ready = false;
  }
  room.showdown = showdown;
  room.history.unshift({
    hand: room.hand,
    result: room.result,
    board: [...room.board],
    at: now,
    actions: room.actions || [],
    players: room.players.filter(player => player.active).map(player => ({
      id: player.id, name: player.name, start: player.startChips, contributed: player.total,
      refund: refunds.get(player.id) || 0, end: player.chips, won: awards.get(player.id) || 0,
      folded: player.folded, cards: [...player.cards], revealed: showdown && playing(player),
    })),
  });
  room.history = room.history.slice(0, HISTORY_LIMIT);
  room.actions = [];
  for (const player of room.players) delete player.queued;
  room.stage = 'finished';
  room.pot = 0;
  setTurn(room, -1, now);
  log(room, room.result.map(result => result.name + ' +' + result.amount + ' (' + result.handName + ')').join(' / '));
  if (room.tournament) {
    const survivors = room.players.filter(player => player.chips > 0);
    if (survivors.length === 1) {
      room.tournament.winnerId = survivors[0].id;
      room.tournament.finishedAt = now;
      room.tournament.nextLevelAt = null;
      log(room, survivors[0].name + ' 님이 토너먼트에서 우승했습니다.');
    }
  }
}
