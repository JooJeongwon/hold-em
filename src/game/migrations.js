import { normalizeGameFormat, RING_GAME_FORMAT } from './format.js';

export function migrateRoom(room) {
  const nextRoom = structuredClone(room);
  let changed = false;
  if (!nextRoom.format) {
    nextRoom.format = nextRoom.id === 'ring-sixmax' ? structuredClone(RING_GAME_FORMAT) : { mode: 'legacy' };
    changed = true;
  } else {
    if (!['ring', 'tournament'].includes(nextRoom.format.mode)) return { room: nextRoom, changed: false };
    const format = normalizeGameFormat(nextRoom.format);
    if (JSON.stringify(format) !== JSON.stringify(nextRoom.format)) changed = true;
    nextRoom.format = format;
  }
  if (nextRoom.format.mode === 'tournament' && !nextRoom.tournament) {
    nextRoom.tournament = { level: 1, startedAt: null, nextLevelAt: null, winnerId: null };
    changed = true;
  }
  for (const key of ['chipUnit', 'smallBlind', 'bigBlind']) {
    if (key in nextRoom) {
      delete nextRoom[key];
      changed = true;
    }
  }
  if (nextRoom.minRaise === undefined) {
    nextRoom.minRaise = nextRoom.format.blinds.big;
    changed = true;
  }
  if (nextRoom.nextHandAt === undefined) {
    nextRoom.nextHandAt = null;
    changed = true;
  }
  if (changed) nextRoom.revision = (nextRoom.revision || 0) + 1;
  return { room: nextRoom, changed };
}
