import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { acquireRepoLock } from '../src/lock.ts';
import { VerifyPool, parseWatchCliArgs, watchRepo } from '../src/orchestrator/watch.ts';
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

test('parseWatchCliArgs: accetta numeri positivi e converte unità', () => {
  assert.deepEqual(parseWatchCliArgs('30', '10'), { intervalMs: 30_000, maxRuntimeMs: 600_000 });
  assert.deepEqual(parseWatchCliArgs(null, null), {});
});

test('parseWatchCliArgs: rifiuta valori non numerici', () => {
  assert.throws(() => parseWatchCliArgs('foo', null), /--interval/);
  assert.throws(() => parseWatchCliArgs(null, '-5'), /--max-runtime/);
  assert.throws(() => parseWatchCliArgs('0', null), /--interval/);
});

test('watchRepo: rilascia il lock se getVerifier fallisce', async () => {
  const prevHome = process.env.MERGESMITH_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'mergesmith-watch-lock-'));
  process.env.MERGESMITH_HOME = dir;
  try {
    const configDir = mkdtempSync(join(tmpdir(), 'mergesmith-watch-cfg-'));
    try {
      writeFileSync(
        join(configDir, 'mergesmith.config.json'),
        JSON.stringify({
          repo: 'org/watch-lock-test',
          implementer: { provider: 'cursor' },
          verifier: { provider: 'unknown-provider' },
        }),
      );
      const config = loadConfig(configDir);
      await assert.rejects(() => watchRepo(config), /Verifier provider sconosciuto/);
      const release = acquireRepoLock(config.repo);
      assert.ok(release, 'lock deve essere rilasciato dopo errore getVerifier');
      release!();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  } finally {
    if (prevHome === undefined) delete process.env.MERGESMITH_HOME;
    else process.env.MERGESMITH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
