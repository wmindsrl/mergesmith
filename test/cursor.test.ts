import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCursorProvider, isTransientError } from '../src/providers/cursor.ts';
import { FollowupError } from '../src/providers/types.ts';

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

// --- followup: 409 body discrimination (issue #1: agent_archived is NOT "busy") ---

const ARCHIVED_BODY = '{"error":{"code":"agent_archived","message":"Agent is archived"}}';
const BUSY_BODY = '{"error":{"code":"agent_busy","message":"Agent is busy"}}';

/** Stub globalThis.fetch with a route handler; records every call. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: string }): {
  calls: Array<{ url: string; method: string }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const res = handler(url, init);
    return new Response(res.body, { status: res.status });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

function testProvider() {
  process.env.CURSOR_TEST_KEY = 'test-key';
  return createCursorProvider({ apiKeyEnv: 'CURSOR_TEST_KEY', branchPrefix: 'cursor/' });
}

test('followup: 409 agent_archived → unarchive + retry once, delivered (no throw)', async () => {
  let unarchived = false;
  const { calls, restore } = stubFetch((url) => {
    if (url.endsWith('/unarchive')) {
      unarchived = true;
      return { status: 200, body: '{}' };
    }
    if (url.endsWith('/runs')) {
      return unarchived ? { status: 200, body: '{"id":"run-2"}' } : { status: 409, body: ARCHIVED_BODY };
    }
    throw new Error(`route inattesa: ${url}`);
  });
  try {
    await testProvider().followup({ provider: 'cursor', agentId: 'agent-1' }, 'fix it');
    assert.equal(calls.filter((c) => c.url.endsWith('/unarchive')).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith('/runs')).length, 2);
  } finally {
    restore();
  }
});

test('followup: 409 agent_busy → FollowupError busy, nessun unarchive', async () => {
  const { calls, restore } = stubFetch(() => ({ status: 409, body: BUSY_BODY }));
  try {
    await assert.rejects(
      testProvider().followup({ provider: 'cursor', agentId: 'agent-1' }, 'fix it'),
      (err: unknown) => err instanceof FollowupError && err.kind === 'busy',
    );
    assert.equal(calls.filter((c) => c.url.endsWith('/unarchive')).length, 0);
  } finally {
    restore();
  }
});

test('followup: ancora archived dopo unarchive → un solo retry, poi FollowupError (niente loop)', async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.endsWith('/unarchive')) return { status: 200, body: '{}' };
    return { status: 409, body: ARCHIVED_BODY };
  });
  try {
    await assert.rejects(
      testProvider().followup({ provider: 'cursor', agentId: 'agent-1' }, 'fix it'),
      (err: unknown) => err instanceof FollowupError && err.kind === 'busy',
    );
    assert.equal(calls.filter((c) => c.url.endsWith('/unarchive')).length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith('/runs')).length, 2);
  } finally {
    restore();
  }
});
