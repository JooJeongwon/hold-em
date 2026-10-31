import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BET_SIZES, raisePresets, raisePreview } from '../public/betting.js';
import { createRoom, addPlayer } from '../src/game/room.js';
import { startHand, legalActions } from '../src/game/holdem.js';

function headsUp() {
  let room = createRoom('betting', 'p0', '베팅 확인', { mode: 'ring' });
  room.format = { ...room.format, buyIn: 20000, maxPlayers: 6, blinds: { small: 100, big: 200 }, rebuy: { enabled: true, amount: 20000 } };
  room.minRaise = 200;
  for (const id of ['p0', 'p1']) { room = addPlayer(room, id, id); room.players.at(-1).ready = true; }
  room = startHand(room, 'p0', Array.from({ length: 52 }, (_, index) => index), 0);
  const player = room.players[room.turn];
  return { room, player, legal: legalActions(room, player.id) };
}

test('헤즈업 스몰 블라인드는 이미 낸 칩을 빼고 추가 투입과 남은 칩을 본다', () => {
  const { room, player, legal } = headsUp();
  assert.equal(room.sb, room.dealer);
  assert.equal(player.bet, 100);
  assert.deepEqual(raisePreview('400', player, legal, room.format.blinds.big), {
    additional: 300, remaining: 19600, bigBlinds: 2,
  });
  assert.deepEqual(raisePreview(String(legal.max), player, legal, room.format.blinds.big), {
    additional: 19900, remaining: 0, bigBlinds: 100,
  });
});

test('프리플롭 BB와 플랍 이후 팟 프리셋을 콜 후 기준으로 계산한다', () => {
  const { room, legal } = headsUp();
  assert.equal(room.pot, 300);
  assert.equal(legal.toCall, 100);
  assert.deepEqual(raisePresets({ ...room, bigBlind: 200 }, legal, DEFAULT_BET_SIZES.preflop).map(p => p.amount), [500, 600, 800, 1000]);
  assert.deepEqual(raisePresets(room, legal), [
    { label: '33%', amount: 400 },
    { label: '50%', amount: 400 },
    { label: '75%', amount: 500 },
    { label: '100%', amount: 600 },
  ]);
  assert.deepEqual(raisePresets({ pot: 1250, bet: 0 }, { min: 200, max: 5000, toCall: 0 }).map(p => p.amount), [413, 625, 938, 1250]);
});

test('프리셋은 최소 레이즈와 올인 한도를 지킨다', () => {
  assert.deepEqual(raisePresets({ pot: 300, bet: 200 }, { min: 800, max: 1000, toCall: 100 }).map(p => p.amount), [800, 800, 800, 800]);
  assert.deepEqual(raisePresets({ pot: 3000, bet: 200 }, { min: 400, max: 500, toCall: 100 }).map(p => p.amount), [500, 500, 500, 500]);
  assert.deepEqual(raisePresets({ pot: 300, bet: 200 }, { min: 300, max: 300, toCall: 100 }).map(p => p.amount), [300, 300, 300, 300]);
});

test('잘못된 금액은 미리보기 계산을 하지 않고 새 범위에서 다시 검사한다', () => {
  const { room, player, legal } = headsUp();
  for (const amount of ['', ' ', 'NaN', 'Infinity', '399', '20001', '400.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(raisePreview(amount, player, legal, room.format.blinds.big), null, amount);
  }
  assert.equal(raisePreview('400', player, { ...legal, min: 600 }, room.format.blinds.big), null);
});
