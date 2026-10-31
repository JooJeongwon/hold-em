import { legalActions } from './holdem.js';
import { TOURNAMENT_LEVELS, TOURNAMENT_MAX_REENTRIES } from './format.js';
import { tournamentRegistrationOpen } from './room.js';

export function publicRoom(room, id, online = []) {
  const tournamentLevel = room.tournament ? TOURNAMENT_LEVELS[room.tournament.level - 1] : null;
  const handActive = !['waiting', 'finished'].includes(room.stage);
  const blinds = handActive ? room.handBlinds || room.format.blinds : tournamentLevel || room.format.blinds;
  const ante = handActive ? room.handAnte || 0 : tournamentLevel?.ante || 0;
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    format: structuredClone(room.format),
    stage: room.stage,
    board: [...room.board],
    dealer: room.dealer,
    sb: room.sb,
    bb: room.bb,
    turn: room.turn,
    hand: room.hand,
    bet: room.bet,
    smallBlind: blinds.small,
    bigBlind: blinds.big,
    ante,
    ...(room.tournament ? { tournament: { ...structuredClone(room.tournament), activeLevel: handActive ? room.handLevel || room.tournament.level : room.tournament.level, smallBlind: tournamentLevel.small, bigBlind: tournamentLevel.big, ante: tournamentLevel.ante, maxReentries: TOURNAMENT_MAX_REENTRIES, registrationOpen: tournamentRegistrationOpen(room) } } : {}),
    pot: room.pot,
    log: [...room.log],
    result: structuredClone(room.result),
    history: room.history.map(hand => ({
      ...structuredClone(hand),
      players: hand.players?.map(({ cards, revealed, ...player }) => ({
        ...player,
        cards: revealed || player.id === id ? [...cards] : null,
      })),
    })),
    queued: structuredClone(room.players.find(player => player.id === id)?.queued || null),
    revision: room.revision,
    deadline: room.deadline,
    nextHandAt: room.nextHandAt,
    me: id,
    legal: legalActions(room, id),
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      chips: player.chips,
      ...(room.format.mode === 'tournament' ? {
        ...(player.id === id ? { entries: room.records[player.id].tournamentEntries || 0 } : {}),
      } : {}),
      bet: player.bet,
      ready: player.ready,
      active: player.active,
      folded: player.folded,
      lastAction: player.lastAction,
      online: online.includes(player.id),
      cards: player.id === id || (room.stage === 'finished' && room.showdown && player.active && !player.folded)
        ? [...player.cards] : player.cards.map(() => null),
    })),
  };
}
