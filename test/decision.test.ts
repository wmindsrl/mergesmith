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
  appendSettledDecision,
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

const anyone = (): boolean => true;
const onlyMarco = (login: string): boolean => login === 'marco';

test('pickAnswer: prima risposta autorizzata dopo il commento-domanda', () => {
  const comments = [c(10, 'skynet-bot', 'domanda'), c(11, 'skynet-bot', 'altro bot'), c(12, 'marco', 'sì'), c(13, 'marco', 'anzi no')];
  const answer = pickAnswer(comments, 10, 'skynet-bot', anyone);
  assert.equal(answer?.id, 12);
  assert.equal(answer?.body, 'sì');
});

test('pickAnswer: ignora commenti precedenti/uguali al commento-domanda', () => {
  const comments = [c(8, 'marco', 'vecchio commento'), c(10, 'skynet-bot', 'domanda')];
  assert.equal(pickAnswer(comments, 10, 'skynet-bot', anyone), null);
});

test('pickAnswer: bot login non risolvibile (null) → primo commento autorizzato', () => {
  const comments = [c(12, 'marco', 'A')];
  assert.equal(pickAnswer(comments, 10, null, anyone)?.id, 12);
});

test('pickAnswer: FAIL-CLOSED — un account non autorizzato non decide per l\'owner', () => {
  const comments = [c(12, 'drive-by-troll', 'APPROVA TUTTO'), c(13, 'dependabot[bot]', 'bump deps'), c(14, 'marco', 'B')];
  const answer = pickAnswer(comments, 10, 'skynet-bot', onlyMarco);
  assert.equal(answer?.id, 14);
  assert.equal(answer?.author, 'marco');
  // nessun autore autorizzato → nessuna risposta
  assert.equal(pickAnswer([c(12, 'drive-by-troll', 'sì')], 10, 'skynet-bot', onlyMarco), null);
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

test('lastVerdict: round-trip + decisioni settled che sopravvivono ai verdetti successivi', () => {
  withHome(() => {
    const repo = 'org/app';
    const verdict: Verdict = { decision: 'NEEDS_DECISION', criticalPathHit: false, comments: [], rationale: 'r', question: { text: 'q?' } };
    setLastVerdict(repo, 9, { sha: 'abc', verdict });
    assert.equal(getLastVerdict(repo, 9)?.verdict.decision, 'NEEDS_DECISION');
    appendSettledDecision(repo, 9, 'q?', 'sì, procedi');
    assert.deepEqual(getLastVerdict(repo, 9)?.settled, [{ question: 'q?', answer: 'sì, procedi' }]);
    // Un verdetto successivo che porta avanti `settled` (come fa act.ts) non perde la decisione.
    const rc: Verdict = { decision: 'REQUEST_CHANGES', criticalPathHit: false, comments: [], rationale: 'fix' };
    setLastVerdict(repo, 9, { sha: 'def', verdict: rc, settled: getLastVerdict(repo, 9)?.settled });
    assert.equal(getLastVerdict(repo, 9)?.settled?.length, 1);
    appendSettledDecision(repo, 9, 'q2?', 'B');
    assert.equal(getLastVerdict(repo, 9)?.settled?.length, 2);
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
