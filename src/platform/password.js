const ITERATIONS = 310000;
const MAX_ITERATIONS_PER_CALL = 100000;
const HASH_FORMAT = 'pbkdf2-sha256-chain-310k-v1$';
const encoder = new TextEncoder();
const toHex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const fromHex = value => Uint8Array.from(value.match(/.{2}/g) || [], pair => Number.parseInt(pair, 16));

async function derive(password, salt) {
  let input = encoder.encode(password);
  // Workers caps each PBKDF2 call at 100,000 iterations; chaining keeps the total work factor.
  for (let remaining = ITERATIONS, stage = 0; remaining > 0; stage++) {
    const iterations = Math.min(remaining, MAX_ITERATIONS_PER_CALL);
    const stageSalt = new Uint8Array(salt.length + 1);
    stageSalt.set(salt);
    stageSalt[salt.length] = stage;
    const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    input = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: stageSalt, iterations }, key, 256,
    ));
    remaining -= iterations;
  }
  return input;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toHex(salt), hash: HASH_FORMAT + toHex(await derive(password, salt)) };
}

export async function verifyPassword(password, salt, expected) {
  const actual = toHex(await derive(password, fromHex(salt)));
  const digest = expected.startsWith(HASH_FORMAT) ? expected.slice(HASH_FORMAT.length) : '';
  let difference = actual.length ^ digest.length;
  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ (digest.charCodeAt(index) || 0);
  }
  return difference === 0;
}
