// Per-repo advisory lock (CLI-level): two `mergesmith tick`/verify runs on the same repo must
// not race on mergesmith-verdict.json or the state JSON. The cron wrapper's flock only covers
// the cron; this covers manual runs too. Stale locks (>45 min) are stolen.
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './config.js';

const STALE_MS = 45 * 60 * 1000;

/** Touch the lock so a long-lived holder (the watch daemon) isn't stolen as stale at 45 min.
 * Call it periodically while holding the lock. Best-effort. */
export function refreshRepoLock(repo: string): void {
  try {
    const now = new Date();
    utimesSync(join(stateDir(repo), 'tick.lock'), now, now);
  } catch {
    /* ignore */
  }
}

// Returns a release() to call when done, or null if another live process holds the lock.
export function acquireRepoLock(repo: string): (() => void) | null {
  const lockPath = join(stateDir(repo), 'tick.lock');
  mkdirSync(dirname(lockPath), { recursive: true });

  const openExclusive = (): number | null => {
    try {
      return openSync(lockPath, 'wx'); // O_CREAT | O_EXCL: fails if it already exists
    } catch {
      return null;
    }
  };

  let fd = openExclusive();
  if (fd === null) {
    // Held — steal only if stale (previous run crashed without releasing).
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age < STALE_MS) return null;
      unlinkSync(lockPath);
      fd = openExclusive();
    } catch {
      return null;
    }
    if (fd === null) return null;
  }

  writeSync(fd, `${process.pid}\n`);
  const heldFd = fd;
  return () => {
    try {
      closeSync(heldFd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  };
}
