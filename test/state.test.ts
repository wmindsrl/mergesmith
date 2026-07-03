import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getThread,
  setThread,
  recordIssue,
  issueForBranch,
  refForBranch,
  knownBranches,
  markReviewed,
  loadReviewed,
} from '../src/orchestrator/state.ts';

// config.ts reads MERGESMITH_HOME dynamically, so pointing it at a temp dir isolates state per test.
function withHome(fn: () => void): void {
  const prev = process.env.MERGESMITH_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'mergesmith-home-'));
  process.env.MERGESMITH_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.MERGESMITH_HOME;
    else process.env.MERGESMITH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('threads: null before set, round-trips after, scoped per pr', () => {
  withHome(() => {
    const repo = 'org/app';
    assert.equal(getThread(repo, 42), null);
    setThread(repo, 42, '1700000000.000100', 'C123');
    assert.deepEqual(getThread(repo, 42), { ts: '1700000000.000100', channel: 'C123' });
    // A different PR has no thread yet, and setting it must not touch #42's.
    assert.equal(getThread(repo, 99), null);
    setThread(repo, 99, '1700000000.000200', 'C123');
    assert.deepEqual(getThread(repo, 42), { ts: '1700000000.000100', channel: 'C123' });
  });
});

test('refForBranch/knownBranches: resolve issue-tracked (Mode A) branches, not only runs', () => {
  withHome(() => {
    const repo = 'org/app';
    recordIssue(repo, {
      issueNumber: 7,
      ref: { provider: 'cursor', agentId: 'a7', runId: 'r7' },
      branch: 'cursor/issue-7',
      prUrl: null,
      dispatchedAt: '2026-07-03T00:00:00Z',
    });
    assert.deepEqual(refForBranch(repo, 'cursor/issue-7'), { provider: 'cursor', agentId: 'a7', runId: 'r7' });
    assert.ok(knownBranches(repo).includes('cursor/issue-7'));
    assert.equal(refForBranch(repo, 'cursor/unknown'), null);
  });
});

test('threads: setThread preserves other state (issues, reviewed) in the same file', () => {
  withHome(() => {
    const repo = 'org/app';
    recordIssue(repo, {
      issueNumber: 5,
      ref: { provider: 'cursor', agentId: 'a1' },
      branch: 'cursor/fix-5',
      prUrl: null,
      dispatchedAt: '2026-07-03T00:00:00Z',
    });
    markReviewed(repo, 5, 'sha-abc');
    setThread(repo, 5, 'ts-5', 'C1');
    // The thread write must not clobber the issues map or the reviewed file.
    assert.deepEqual(getThread(repo, 5), { ts: 'ts-5', channel: 'C1' });
    assert.equal(issueForBranch(repo, 'cursor/fix-5')?.issueNumber, 5);
    assert.equal(loadReviewed(repo)['5'], 'sha-abc');
  });
});
