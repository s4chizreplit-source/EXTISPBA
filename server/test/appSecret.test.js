import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decryptAppSecret,
  encryptAppSecret,
} from '../src/services/appSecret.js';

test('application secrets round-trip without exposing plaintext', () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret-for-app-secret';
  try {
    const encrypted = encryptAppSecret('zapupi-key-example');
    assert.equal(encrypted.includes('zapupi-key-example'), false);
    assert.equal(decryptAppSecret(encrypted), 'zapupi-key-example');
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test('tampered application secrets are rejected', () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret-for-app-secret';
  try {
    const encrypted = encryptAppSecret('zapupi-key-example');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
    assert.throws(() => decryptAppSecret(tampered));
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});