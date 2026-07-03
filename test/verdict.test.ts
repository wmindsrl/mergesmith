import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerdict, VERDICT_FILE } from '../src/providers/verdict.ts';

function withVerdict(content: string | null, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mergesmith-v-'));
  try {
    if (content !== null) writeFileSync(join(dir, VERDICT_FILE), content);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readVerdict: valid → parsed, attribution set, file removed', () => {
  const v = JSON.stringify({ decision: 'APPROVE', criticalPathHit: false, rationale: 'ok', comments: [] });
  withVerdict(v, (dir) => {
    const verdict = readVerdict(dir, 7, 'claude-code', 'opus');
    assert.equal(verdict.decision, 'APPROVE');
    assert.equal(verdict.criticalPathHit, false);
    assert.deepEqual(verdict.attribution, { engine: 'claude-code', model: 'opus' });
    assert.equal(existsSync(join(dir, VERDICT_FILE)), false);
  });
});

test('readVerdict: FAIL-CLOSED when criticalPathHit missing', () => {
  withVerdict(JSON.stringify({ decision: 'APPROVE', rationale: 'ok' }), (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /criticalPathHit/);
  });
});

test('readVerdict: FAIL-CLOSED when criticalPathHit non-boolean', () => {
  withVerdict(JSON.stringify({ decision: 'APPROVE', criticalPathHit: 'no', rationale: 'ok' }), (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /criticalPathHit/);
  });
});

test('readVerdict: invalid decision throws', () => {
  withVerdict(JSON.stringify({ decision: 'MAYBE', criticalPathHit: false, rationale: 'x' }), (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /decision/);
  });
});

test('readVerdict: malformed JSON throws', () => {
  withVerdict('{ not json', (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /malformato/);
  });
});

test('readVerdict: missing file throws', () => {
  withVerdict(null, (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /nessun verdetto/);
  });
});
