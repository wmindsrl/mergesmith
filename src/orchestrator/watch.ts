// `mergesmith watch`: the tick, without the wait. A single long-lived process where every PR
// advances AS SOON AS its gate opens (CI green → verify now; verdict → follow-up now) instead of
// re-aligning to the next cron tick. One process owns the state (no cross-process races, no
// flock-skipped ticks: a slow verify never blocks another PR's merge), verifies run in a
// persistent pool, and the existing cron becomes the WATCHDOG: it tries to start the watch every
// few minutes and exits immediately while one is alive; the watch exits cleanly after
// maxRuntime, so the cron's schedule window (e.g. 7-21) keeps bounding when the loop runs.
import { existsSync } from 'node:fs';
import { loadConfig, pausedFlagPath, reposRegistryPath, type MergesmithConfig } from '../config.js';
import { acquireRepoLock, refreshRepoLock } from '../lock.js';
import { readJson } from '../lib.js';
import type { OpenPR } from '../github.js';
import { getVerifier } from '../providers/registry.js';
import { MAX_CONCURRENT_VERIFY, scanRepo, sweepAndHeartbeat, verifyAndApply } from './tick.js';

export interface WatchOptions {
  /** Local checkout dir of the target repo (multi-repo: passed to the verifier as cwd). */
  repoPath?: string;
  /** Pause between scans. Scans are cheap (a handful of gh calls); verifies run in the pool. */
  intervalMs?: number;
  /** Clean exit after this long — the cron watchdog restarts the watch while inside its
   * schedule window. Also caps the blast radius of any slow leak. */
  maxRuntimeMs?: number;
  /** Run Slack-inbox intake + stall sweeps every N scans (they're the chattier calls). */
  intakeEveryN?: number;
}

const DEFAULT_INTERVAL_MS = 40_000;
const DEFAULT_MAX_RUNTIME_MS = 55 * 60_000; // < lock STALE_MS would not matter: we refresh it
const DEFAULT_INTAKE_EVERY_N = 4;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Persistent verify pool: at most `max` concurrent verifies, deduped by PR number — a PR
 * already queued or in flight is never double-submitted, so the scan can re-submit blindly
 * every pass. `run` must never reject (verifyAndApply handles its own failures).
 */
export class VerifyPool {
  private readonly inflight = new Set<number>();
  private readonly queue: OpenPR[] = [];
  private active = 0;
  private readonly onIdle: Array<() => void> = [];

  constructor(
    private readonly run: (pr: OpenPR) => Promise<void>,
    private readonly max: number,
  ) {}

  submit(pr: OpenPR): void {
    if (this.inflight.has(pr.number)) return;
    this.inflight.add(pr.number);
    this.queue.push(pr);
    this.pump();
  }

  get busy(): boolean {
    return this.active > 0 || this.queue.length > 0;
  }

  /** Resolves when queue + in-flight are both empty (used for the clean drain on exit). */
  async drain(): Promise<void> {
    if (!this.busy) return;
    await new Promise<void>((resolve) => this.onIdle.push(resolve));
  }

  private pump(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const pr = this.queue.shift()!;
      this.active++;
      void this.run(pr)
        .catch((error) => console.error(`✗ verify pool PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.active--;
          this.inflight.delete(pr.number);
          this.pump();
          if (!this.busy) for (const resolve of this.onIdle.splice(0)) resolve();
        });
    }
  }
}

export async function watchRepo(config: MergesmithConfig, opts: WatchOptions = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxRuntimeMs = opts.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  const intakeEveryN = opts.intakeEveryN ?? DEFAULT_INTAKE_EVERY_N;

  // Same per-repo lock as the tick, held for the daemon's lifetime: a cron `tick` that fires
  // meanwhile skips cleanly, and a second `watch` can't start. Refreshed every scan so the
  // 45-min stale-steal never hits a live daemon.
  const release = acquireRepoLock(config.repo);
  if (!release) {
    console.log(`watch ${config.repo}: già in corso (lock), skip`);
    return;
  }

  const verifier = getVerifier(config);
  const pool = new VerifyPool(
    (pr) => verifyAndApply(config, { repoPath: opts.repoPath }, verifier, pr),
    MAX_CONCURRENT_VERIFY,
  );

  let stop: string | null = null;
  const onSignal = (signal: string) => () => {
    stop = signal;
  };
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('SIGTERM', onSignal('SIGTERM'));

  const startedAt = Date.now();
  console.log(`watch ${config.repo}: avviato (scan ogni ${Math.round(intervalMs / 1000)}s, exit tra ${Math.round(maxRuntimeMs / 60000)}m)`);
  let iteration = 0;
  let pausedLogged = false;

  try {
    while (stop === null && Date.now() - startedAt < maxRuntimeMs) {
      refreshRepoLock(config.repo);
      if (existsSync(pausedFlagPath())) {
        if (!pausedLogged) {
          console.log(`watch ${config.repo}: in pausa (${pausedFlagPath()} presente) — idle`);
          pausedLogged = true;
        }
      } else {
        pausedLogged = false;
        const intake = iteration % intakeEveryN === 0;
        try {
          await scanRepo(config, { repoPath: opts.repoPath, skipIntake: !intake }, (pr) => pool.submit(pr));
          await sweepAndHeartbeat(config, intake);
        } catch (error) {
          // One bad scan (network blip, gh error) must not kill the daemon — next scan retries.
          console.error(`✗ watch scan: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      iteration++;
      await sleep(intervalMs);
    }
    console.log(`watch ${config.repo}: ${stop ?? 'max-runtime'} — drain delle verify in corso`);
    await pool.drain();
  } finally {
    release();
  }
  console.log(`watch ${config.repo}: chiuso pulito dopo ${Math.round((Date.now() - startedAt) / 60000)}m`);
}

export async function watchAll(opts: Omit<WatchOptions, 'repoPath'> = {}): Promise<void> {
  const registryPath = reposRegistryPath();
  const registry = readJson<{ repos: Array<{ path: string }> }>(registryPath, { repos: [] });
  if (registry.repos.length === 0) {
    console.warn(`Nessun repo registrato in ${registryPath}. Aggiungi { "repos": [{ "path": "/path/al/repo" }] }`);
    return;
  }
  // Ogni repo è un watch indipendente nello stesso processo (stato per-repo, nessuna condivisione).
  await Promise.all(
    registry.repos.map(async (entry) => {
      try {
        await watchRepo(loadConfig(entry.path), { ...opts, repoPath: entry.path });
      } catch (error) {
        console.error(`watch ${entry.path}: ${error}`);
      }
    }),
  );
}
