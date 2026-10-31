import { normalizeGameFormat, TOURNAMENT_GAME_FORMAT, TOURNAMENT_LEVELS, TOURNAMENT_MAX_REENTRIES } from './format.js';

const copy = state => structuredClone(state);
const idle = room => ['waiting', 'finished'].includes(room.stage);

export function ringBuyInWeek(now = Date.now()) {
  const date = new Date(now + 9 * 60 * 60 * 1000);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

function log(room, message) {
  room.log.unshift(message);
  room.log = room.log.slice(0, 35);
}

export function createRoom(id, hostId, name, format = TOURNAMENT_GAME_FORMAT) {
  const gameFormat = normalizeGameFormat(format);
  return {
    id, name, hostId, format: gameFormat, players: [], records: {},
    ...(gameFormat.mode === 'tournament' ? { tournament: { level: 1, startedAt: null, nextLevelAt: null, winnerId: null } } : {}),
    stage: 'waiting', board: [], deck: [], dealer: -1, turn: -1, hand: 0, bet: 0,
    minRaise: gameFormat.blinds.big, pot: 0, log: [], result: [], history: [],
    revision: 0, deadline: null, nextHandAt: null,
  };
}

export function addPlayer(room, id, name) {
  const nextRoom = copy(room);
  const existing = nextRoom.players.find(player => player.id === id);
  if (existing) {
    existing.name = name;
    nextRoom.records[id].name = name;
    return nextRoom;
  }
  if (nextRoom.format.mode === 'tournament' && !tournamentRegistrationOpen(nextRoom)) throw new Error('토너먼트 참가 등록이 마감됐습니다.');
  if (!idle(nextRoom) && nextRoom.format.mode !== 'tournament') throw new Error('진행 중인 핸드가 끝난 뒤 입장해 주세요.');
  if (nextRoom.players.length >= nextRoom.format.maxPlayers) throw new Error('테이블 정원이 가득 찼습니다.');
  if (!nextRoom.records[id] && Object.keys(nextRoom.records).length >= 100) throw new Error('이 방의 참가 기록이 가득 찼습니다. 새 방을 만들어 주세요.');
  nextRoom.records[id] ||= { id, name, tournamentEntries: 0 };
  nextRoom.records[id].name = name;
  nextRoom.players.push({
    id, name, chips: nextRoom.format.buyIn, cards: [], folded: false, active: false,
    bet: 0, total: 0, actedAt: null, ready: false, lastAction: '대기 중',
  });
  if (!nextRoom.players.some(player => player.id === nextRoom.hostId)) nextRoom.hostId = id;
  log(nextRoom, name + ' 님이 입장했습니다.');
  return nextRoom;
}

export function toggleReady(room, id) {
  const nextRoom = copy(room);
  const player = nextRoom.players.find(entry => entry.id === id);
  if (!player || !idle(nextRoom) || player.chips <= 0) throw new Error('다음 핸드 대기 중에 준비할 수 있습니다.');
  player.ready = !player.ready;
  return nextRoom;
}

export function clearOfflineReady(room, onlineIds) {
  const online = new Set(onlineIds);
  const nextRoom = copy(room);
  for (const player of nextRoom.players) if (!online.has(player.id)) player.ready = false;
  return nextRoom;
}

export function advanceTournamentLevel(room, now) {
  if (room?.format.mode !== 'tournament' || !room.tournament?.nextLevelAt || room.tournament.nextLevelAt > now) return room;
  const nextRoom = copy(room);
  const duration = nextRoom.format.tournamentSpeed === 'turbo' ? 3 : 6;
  while (nextRoom.tournament.nextLevelAt && nextRoom.tournament.nextLevelAt <= now) {
    if (nextRoom.tournament.level >= TOURNAMENT_LEVELS.length) {
      nextRoom.tournament.nextLevelAt = null;
      break;
    }
    nextRoom.tournament.level++;
    const { small, big, ante } = TOURNAMENT_LEVELS[nextRoom.tournament.level - 1];
    log(nextRoom, `블라인드 레벨 ${nextRoom.tournament.level}: ${small} / ${big} · 앤티 ${ante}`);
    nextRoom.tournament.nextLevelAt = nextRoom.tournament.level === TOURNAMENT_LEVELS.length
      ? null : nextRoom.tournament.nextLevelAt + duration * 60 * 1000;
  }
  return nextRoom;
}

export function tournamentRegistrationOpen(room, now = Date.now()) {
  if (room?.format.mode !== 'tournament' || !room.tournament || room.tournament.winnerId) return false;
  const current = advanceTournamentLevel(room, now);
  const bigBlind = TOURNAMENT_LEVELS[current.tournament.level - 1]?.big;
  return current.tournament.startedAt === null || Number.isSafeInteger(bigBlind) && current.format.buyIn >= 5 * bigBlind;
}

export function recordTournamentEntry(room, id, entryMethod) {
  const nextRoom = copy(room);
  const player = nextRoom.players.find(entry => entry.id === id);
  const record = nextRoom.records[id];
  const entries = record?.tournamentEntries || 0;
  const canJoinMidHand = entries === 0 && tournamentRegistrationOpen(nextRoom);
  if (nextRoom.format.mode !== 'tournament' || !player || !record || (!idle(nextRoom) && !canJoinMidHand) || !['money', 'count'].includes(entryMethod) || !tournamentRegistrationOpen(nextRoom) || entries >= TOURNAMENT_MAX_REENTRIES + 1 || (entries > 0 && player.chips !== 0)) {
    throw new Error('토너먼트 참가 또는 리엔트리 조건을 확인해 주세요.');
  }
  player.chips = nextRoom.format.buyIn;
  player.ready = false;
  record.tournamentEntries = entries + 1;
  return nextRoom;
}

export function refillRingStack(room, id, amount) {
  const nextRoom = copy(room);
  const player = nextRoom.players.find(entry => entry.id === id);
  if (nextRoom.format.mode !== 'ring' || !player || !idle(nextRoom) || !Number.isSafeInteger(amount) || amount <= 0 || player.chips + amount > nextRoom.format.buyIn) {
    throw new Error('링게임 자동 보충 금액을 확인해 주세요.');
  }
  player.chips += amount;
  player.ready = false;
  return nextRoom;
}

export function rebuyPlayer(room, id) {
  const nextRoom = copy(room);
  const player = nextRoom.players.find(entry => entry.id === id);
  if (nextRoom.format.mode !== 'ring' || !player || !idle(nextRoom) || player.chips > 5000) {
    throw new Error('칩이 5,000 이하일 때 대기 중에 추가 바이인할 수 있습니다.');
  }
  player.chips = nextRoom.format.rebuy.amount;
  player.ready = false;
  return nextRoom;
}

export function leavePlayer(room, id) {
  const nextRoom = copy(room);
  if (nextRoom.format.mode !== 'ring') throw new Error('토너먼트에 참가한 뒤에는 나갈 수 없습니다.');
  if (!idle(nextRoom)) throw new Error('현재 핸드가 끝난 뒤 나갈 수 없습니다.');
  const dealerId = nextRoom.players[nextRoom.dealer]?.id;
  nextRoom.players = nextRoom.players.filter(player => player.id !== id);
  nextRoom.dealer = nextRoom.players.findIndex(player => player.id === dealerId);
  if (nextRoom.hostId === id) nextRoom.hostId = nextRoom.players[0]?.id || null;
  return nextRoom;
}

export function claimHost(room, id, hostOnline) {
  const nextRoom = copy(room);
  if (!idle(nextRoom) || hostOnline) throw new Error('방장이 접속 중입니다.');
  nextRoom.hostId = id;
  return nextRoom;
}
