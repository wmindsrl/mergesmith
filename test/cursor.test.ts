import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientError } from '../src/providers/cursor.ts';

test('isTransientError: network blips / 5xx / 429 are retryable', () => {
  assert.equal(isTransientError('TypeError: fetch failed'), true);
  assert.equal(isTransientError('Cursor API POST /v1/agents/x/runs → 503: bad gateway'), true);
  assert.equal(isTransientError('Cursor API POST /x → 500: internal'), true);
  assert.equal(isTransientError('Cursor API POST /x → 429: rate limited'), true);
  assert.equal(isTransientError('read ECONNRESET'), true);
  assert.equal(isTransientError('socket hang up'), true);
});

test('isTransientError: real 4xx / unknown errors are NOT transient', () => {
  assert.equal(isTransientError('Cursor API POST /x → 404: not found'), false);
  assert.equal(isTransientError('Cursor API POST /x → 400: bad request'), false);
  assert.equal(isTransientError('some unexpected error'), false);
});
