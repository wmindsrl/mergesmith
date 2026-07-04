import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prGateAction, noOpRecovery } from '../src/orchestrator/tick.ts';

test('prGateAction: no PR (stall candidate) / open / done', () => {
  assert.equal(prGateAction([]), 'none'); // agent never opened a PR → sweep it
  assert.equal(prGateAction(['OPEN']), 'open'); // per-PR loop owns it
  assert.equal(prGateAction(['MERGED']), 'merged'); // run finished
  assert.equal(prGateAction(['CLOSED']), 'merged'); // closed w/o merge → also over, don't sweep
  assert.equal(prGateAction(['MERGED', 'CLOSED']), 'merged');
  assert.equal(prGateAction(['CLOSED', 'OPEN']), 'open'); // any OPEN → still active
});

test('noOpRecovery: gone / giveup / nudge / recover', () => {
  const spec = 'aaa';
  assert.equal(noOpRecovery(null, spec, 0, 2), 'gone'); // branch vanished without a PR
  assert.equal(noOpRecovery('bbb', spec, 0, 2), 'nudge'); // head != specSha → committed, only PR missing
  assert.equal(noOpRecovery('aaa', spec, 0, 2), 'recover'); // head == specSha → pure no-op → redo
  assert.equal(noOpRecovery('aaa', spec, 1, 2), 'recover');
  assert.equal(noOpRecovery('aaa', spec, 2, 2), 'giveup'); // attempts exhausted → needs-human
  assert.equal(noOpRecovery('bbb', spec, 2, 2), 'giveup');
  assert.equal(noOpRecovery(null, spec, 5, 2), 'gone'); // branch-gone is terminal regardless of attempts
});
