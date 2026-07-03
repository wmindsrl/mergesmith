import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecap, prState } from '../src/recap.ts';
import { DEFAULT_LABELS } from '../src/config.ts';

test('prState: most-blocking label wins', () => {
  const L = DEFAULT_LABELS;
  assert.match(prState([L.needsHuman, L.approved], L), /needs-human/);
  assert.match(prState([L.rework], L), /rework/);
  assert.match(prState([L.ciRed], L), /ci-red/);
  assert.match(prState([L.approved], L), /approved/);
  assert.match(prState([L.managed], L), /in review/); // no state label → default
});

test('formatRecap: lists PRs and issues', () => {
  const out = formatRecap({
    repo: 'org/app',
    prs: [
      { number: 12, branch: 'cursor/fix-a', state: '👀 in review' },
      { number: 13, branch: 'cursor/fix-b', state: '🔴 needs-human' },
    ],
    ready: [20, 21],
    inProgress: [22],
    needsTriage: [],
  });
  assert.match(out, /org\/app/);
  assert.match(out, /#12 `cursor\/fix-a` — 👀 in review/);
  assert.match(out, /#13 `cursor\/fix-b` — 🔴 needs-human/);
  assert.match(out, /pronte\* \(2\): #20, #21/);
  assert.match(out, /in lavorazione\* \(1\): #22/);
  assert.doesNotMatch(out, /da triage/); // empty groups omitted
});

test('formatRecap: empty state says so', () => {
  const out = formatRecap({ repo: 'org/app', prs: [], ready: [], inProgress: [], needsTriage: [] });
  assert.match(out, /Niente in coda/);
});
