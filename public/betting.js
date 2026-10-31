export const DEFAULT_BET_SIZES = Object.freeze({
  preflop: Object.freeze([2.5, 3, 4, 5].map(value => Object.freeze({ unit: 'bb', value }))),
  postflop: Object.freeze([33, 50, 75, 100].map(value => Object.freeze({ unit: 'pot', value }))),
});

export function raisePresets(room, legal, sizes = DEFAULT_BET_SIZES.postflop) {
  const potAfterCall = room.pot + legal.toCall;
  return sizes.map(({ unit, value }) => {
    const target = unit === 'bb' ? room.bigBlind * value : room.bet + potAfterCall * value / 100;
    const amount = Math.min(legal.max, Math.max(legal.min, Math.round(target)));
    return { label: unit === 'bb' ? `${value} BB` : `${value}%`, amount };
  });
}

export function raisePreview(value, player, legal, bigBlind) {
  if (String(value).trim() === '') return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < legal.min || amount > legal.max) return null;
  const additional = amount - player.bet;
  return { additional, remaining: player.chips - additional, bigBlinds: amount / bigBlind };
}
