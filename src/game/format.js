export const RING_GAME_FORMAT = Object.freeze({
  mode: 'ring', buyIn: 10000, maxPlayers: 6,
  blinds: Object.freeze({ small: 100, big: 200 }),
  rebuy: Object.freeze({ enabled: true, amount: 10000 }),
  turnTimeoutMs: 20000,
});
export const TOURNAMENT_GAME_FORMAT = Object.freeze({
  mode: 'tournament', buyIn: 10000, maxPlayers: 9,
  blinds: Object.freeze({ small: 25, big: 50 }), ante: 5,
  rebuy: Object.freeze({ enabled: true, amount: 10000 }),
  turnTimeoutMs: 20000, tournamentSpeed: 'normal',
});
export const TOURNAMENT_LEVELS = Object.freeze([
  [25, 50, 5], [50, 100, 10], [75, 150, 15], [100, 200, 20], [125, 250, 25],
  [150, 300, 30], [200, 400, 40], [250, 500, 50], [300, 600, 60], [400, 800, 80],
  [500, 1000, 100], [600, 1200, 120], [800, 1600, 160], [1000, 2000, 200], [1200, 2400, 240],
  [1400, 2800, 280], [1600, 3200, 320], [2000, 4000, 400], [2500, 5000, 500], [3000, 6000, 600],
  [3500, 7000, 700], [4000, 8000, 800], [5000, 10000, 1000], [6000, 12000, 1200], [8000, 16000, 1600],
  [10000, 20000, 2000], [12000, 24000, 2400], [14000, 28000, 2800], [16000, 32000, 3200], [20000, 40000, 4000],
  [25000, 50000, 5000], [30000, 60000, 6000], [35000, 70000, 7000], [40000, 80000, 8000],
].map(([small, big, ante]) => Object.freeze({ small, big, ante })));
export const TOURNAMENT_MAX_REENTRIES = 2;

export function normalizeGameFormat(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('게임 형식을 확인해 주세요.');
  const mode = input.mode ?? TOURNAMENT_GAME_FORMAT.mode;
  if (mode === 'ring') return structuredClone(RING_GAME_FORMAT);
  if (mode === 'tournament') {
    const tournamentSpeed = input.tournamentSpeed ?? 'normal';
    if (!['normal', 'turbo'].includes(tournamentSpeed)) throw new Error('토너먼트 속도를 확인해 주세요.');
    return {
      ...structuredClone(TOURNAMENT_GAME_FORMAT), tournamentSpeed,
    };
  }
  throw new Error('링게임 또는 토너먼트 형식을 선택해 주세요.');
}
