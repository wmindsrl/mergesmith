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

// --- NEEDS_DECISION (una domanda al code-owner) ---

test('readVerdict: NEEDS_DECISION valida con domanda sì/no', () => {
  const v = JSON.stringify({
    decision: 'NEEDS_DECISION',
    criticalPathHit: false,
    rationale: 'workaround su bug esterno',
    comments: [],
    question: { text: 'Il workaround X è accettabile in attesa del fix upstream?' },
  });
  withVerdict(v, (dir) => {
    const verdict = readVerdict(dir, 7, 'claude-code', 'opus');
    assert.equal(verdict.decision, 'NEEDS_DECISION');
    assert.equal(verdict.question?.text.includes('workaround X'), true);
  });
});

test('readVerdict: NEEDS_DECISION con 2-4 opzioni (una recommended)', () => {
  const v = JSON.stringify({
    decision: 'NEEDS_DECISION',
    criticalPathHit: false,
    rationale: 'scelta di persistenza',
    comments: [],
    question: {
      text: 'Dove salviamo lo stato di sync?',
      options: [
        { key: 'A', label: 'tabella dedicata', recommended: true },
        { key: 'B', label: 'colonna JSON su preferences' },
      ],
    },
  });
  withVerdict(v, (dir) => {
    const verdict = readVerdict(dir, 7, 'claude-code');
    assert.equal(verdict.question?.options?.length, 2);
    assert.equal(verdict.question?.options?.[0]?.recommended, true);
  });
});

test('readVerdict: FAIL-CLOSED su NEEDS_DECISION senza question', () => {
  const v = JSON.stringify({ decision: 'NEEDS_DECISION', criticalPathHit: false, rationale: 'x', comments: [] });
  withVerdict(v, (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /question/);
  });
});

test('readVerdict: FAIL-CLOSED su options malformate (1 sola / senza label)', () => {
  const one = JSON.stringify({
    decision: 'NEEDS_DECISION',
    criticalPathHit: false,
    rationale: 'x',
    question: { text: 'q?', options: [{ key: 'A', label: 'solo una' }] },
  });
  withVerdict(one, (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /options/);
  });
  const noLabel = JSON.stringify({
    decision: 'NEEDS_DECISION',
    criticalPathHit: false,
    rationale: 'x',
    question: { text: 'q?', options: [{ key: 'A' }, { key: 'B', label: 'ok' }] },
  });
  withVerdict(noLabel, (dir) => {
    assert.throws(() => readVerdict(dir, 7, 'claude-code'), /options/);
  });
});
