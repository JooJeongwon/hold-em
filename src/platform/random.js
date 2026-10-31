export function shuffledDeck(randomUint32) {
  if (typeof randomUint32 !== 'function') throw new Error('덱 생성용 난수 함수가 필요합니다.');
  const deck = Array.from({ length: 52 }, (_, index) => index);
  for (let index = deck.length - 1; index > 0; index--) {
    const limit = Math.floor(2 ** 32 / (index + 1)) * (index + 1);
    let value;
    do { value = randomUint32(); } while (!Number.isSafeInteger(value) || value < 0 || value >= limit);
    const other = value % (index + 1);
    [deck[index], deck[other]] = [deck[other], deck[index]];
  }
  return deck;
}
