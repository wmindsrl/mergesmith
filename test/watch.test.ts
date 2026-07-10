import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyPool } from '../src/orchestrator/watch.ts';
import type { OpenPR } from '../src/github.ts';

const pr = (n: number): OpenPR => ({ number: n, headRefOid: `sha-${n}`, headRefName: `cursor/x-${n}`, isDraft: false, labels: [] });

/** run() controllabile: ogni PR resta "in verifica" finché il test non la completa. */
function controllableRun(): {
  run: (p: OpenPR) => Promise<void>;
  started: number[];
  finish: (n: number) => void;
} {
  const started: number[] = [];
  const resolvers = new Map<number, () => void>();
  return {
    started,
    run: (p: OpenPR) =>
      new Promise<void>((resolve) => {
        started.push(p.number);
        resolvers.set(p.number, resolve);
      }),
    finish: (n: number) => {
      resolvers.get(n)?.();
      resolvers.delete(n);
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('VerifyPool: dedup per PR — una PR in coda/in volo non viene ri-sottomessa', async () => {
  const { run, started, finish } = controllableRun();
  const pool = new VerifyPool(run, 3);
  pool.submit(pr(1));
  pool.submit(pr(1)); // scan successivo: stessa PR ancora in volo
  await settle();
  assert.deepEqual(started, [1]);
  finish(1);
  await pool.drain();
  // completata → una nuova submit riparte (nuovo SHA, nuovo giro)
  pool.submit(pr(1));
  await settle();
  assert.deepEqual(started, [1, 1]);
  finish(1);
  await pool.drain();
});

test('VerifyPool: max concorrenza rispettato, la coda scorre al completamento', async () => {
  const { run, started, finish } = controllableRun();
  const pool = new VerifyPool(run, 2);
  for (const n of [1, 2, 3, 4]) pool.submit(pr(n));
  await settle();
  assert.deepEqual(started, [1, 2]); // solo 2 in volo
  finish(1);
  await settle();
  assert.deepEqual(started, [1, 2, 3]); // uno slot libero → parte la 3
  finish(2);
  finish(3);
  await settle();
  assert.deepEqual(started, [1, 2, 3, 4]);
  finish(4);
  await pool.drain();
  assert.equal(pool.busy, false);
});

test('VerifyPool: drain attende coda + in-volo; run che rigetta non uccide il pool', async () => {
  let rejected = false;
  const pool = new VerifyPool(async (p) => {
    if (p.number === 1 && !rejected) {
      rejected = true;
      throw new Error('boom');
    }
  }, 1);
  pool.submit(pr(1));
  pool.submit(pr(2));
  await pool.drain();
  assert.equal(pool.busy, false); // il reject di #1 è loggato, #2 è comunque girata
});
