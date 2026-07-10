import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickAnswer } from '../src/orchestrator/tick.ts';
import {
  clearDecision,
  getDecision,
  getLastVerdict,
  setDecision,
  setLastVerdict,
  setLastVerdictAnswer,
  bumpReworkRound,
  clearReworkRound,
  markReviewed,
  unmarkReviewed,
  loadReviewed,
} from '../src/orchestrator/state.ts';
import type { PrComment } from '../src/github.ts';
import type { Verdict } from '../src/providers/types.ts';

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

const c = (id: number, author: string, body: string): PrComment => ({
  id,
  author,
  body,
  createdAt: '2026-07-10T10:00:00Z',
});

test('pickAnswer: prima risposta umana dopo il commento-domanda', () => {
  const comments = [c(10, 'skynet-bot', 'domanda'), c(11, 'skynet-bot', 'altro bot'), c(12, 'marco', 'sì'), c(13, 'marco', 'anzi no')];
  const answer = pickAnswer(comments, 10, 'skynet-bot');
  assert.equal(answer?.id, 12);
  assert.equal(answer?.body, 'sì');
});

test('pickAnswer: ignora commenti precedenti/uguali al commento-domanda', () => {
  const comments = [c(8, 'marco', 'vecchio commento'), c(10, 'skynet-bot', 'domanda')];
  assert.equal(pickAnswer(comments, 10, 'skynet-bot'), null);
});

test('pickAnswer: bot login non risolvibile (null) → primo commento successivo', () => {
  const comments = [c(12, 'marco', 'A')];
  assert.equal(pickAnswer(comments, 10, null)?.id, 12);
});

test('decision state: set/get/clear round-trip', () => {
  withHome(() => {
    const repo = 'org/app';
    assert.equal(getDecision(repo, 5), null);
    setDecision(repo, 5, {
      sha: 'abc',
      question: { text: 'workaround ok?', options: [{ key: 'A', label: 'sì', recommended: true }, { key: 'B', label: 'no' }] },
      askedAt: '2026-07-10T10:00:00Z',
      commentId: 42,
    });
    assert.equal(getDecision(repo, 5)?.commentId, 42);
    assert.equal(getDecision(repo, 5)?.question.options?.length, 2);
    clearDecision(repo, 5);
    assert.equal(getDecision(repo, 5), null);
  });
});

test('lastVerdict: round-trip + answer del code-owner', () => {
  withHome(() => {
    const repo = 'org/app';
    const verdict: Verdict = { decision: 'NEEDS_DECISION', criticalPathHit: false, comments: [], rationale: 'r', question: { text: 'q?' } };
    setLastVerdict(repo, 9, { sha: 'abc', verdict });
    assert.equal(getLastVerdict(repo, 9)?.verdict.decision, 'NEEDS_DECISION');
    setLastVerdictAnswer(repo, 9, 'sì, procedi');
    assert.equal(getLastVerdict(repo, 9)?.answer, 'sì, procedi');
  });
});

test('reworkRounds: bump incrementa, clear azzera', () => {
  withHome(() => {
    const repo = 'org/app';
    assert.equal(bumpReworkRound(repo, 3), 1);
    assert.equal(bumpReworkRound(repo, 3), 2);
    assert.equal(bumpReworkRound(repo, 3), 3);
    assert.equal(bumpReworkRound(repo, 4), 1); // PR indipendenti
    clearReworkRound(repo, 3);
    assert.equal(bumpReworkRound(repo, 3), 1);
  });
});

test('unmarkReviewed: la PR torna verificabile (risposta ricevuta)', () => {
  withHome(() => {
    const repo = 'org/app';
    markReviewed(repo, 7, 'sha-1');
    assert.equal(loadReviewed(repo)['7'], 'sha-1');
    unmarkReviewed(repo, 7);
    assert.equal(loadReviewed(repo)['7'], undefined);
    unmarkReviewed(repo, 7); // idempotente su chiave assente
  });
});
