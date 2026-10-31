import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/platform/password.js';

test('310,000-round PBKDF2 hashes register and verify in supported chunks', async () => {
  const password = 'a long test password';
  const saved = await hashPassword(password);
  assert.match(saved.hash, /^pbkdf2-sha256-chain-310k-v1\$[a-f0-9]{64}$/);
  assert.equal(await verifyPassword(password, saved.salt, saved.hash), true);
  assert.equal(await verifyPassword('incorrect password', saved.salt, saved.hash), false);
});
