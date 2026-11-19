import { randomInt } from 'node:crypto';

// 세 번의 Fisher–Yates 섞기 뒤 균등 난수로 선택합니다. 입력은 변경하지 않습니다.
export function draw(candidates, count, rng = randomInt) {
  const pool = [...new Set(candidates)];
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('추첨 인원이 잘못되었습니다.');
  for (let pass = 0; pass < 3; pass++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rng(i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  const winners = [];
  while (pool.length && winners.length < count) {
    const i = rng(pool.length);
    winners.push(pool[i]);
    pool[i] = pool.at(-1);
    pool.pop();
  }
  return winners;
}
