// Shared verdict read + FAIL-CLOSED validation for verifier providers.
// The review CLI (claude / agent) writes this literal file in cwd — its sandbox blocks
// env-var reads, so we cannot pass a per-PR path in. Both providers read it back here.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Verdict } from './types.js';

export const VERDICT_FILE = 'mergesmith-verdict.json';

export function verdictPath(cwd: string): string {
  return join(cwd, VERDICT_FILE);
}

// Read + validate the verdict the review wrote. FAIL-CLOSED: a malformed/incomplete verdict
// throws (never silently approves). Crucially, a missing/non-boolean `criticalPathHit` is
// rejected, so it can never let a critical-path PR slip past the human gate.
export function readVerdict(cwd: string, prNumber: number, engine: string, model?: string): Verdict {
  const out = join(cwd, VERDICT_FILE);
  if (!existsSync(out)) {
    throw new Error(
      `verifier ${engine}: nessun verdetto per PR #${prNumber} (${out} assente) — la review non ha scritto ${VERDICT_FILE}`,
    );
  }
  const raw = readFileSync(out, 'utf8');
  rmSync(out, { force: true }); // cleanup so a stale verdict can't be reused next run
  let verdict: Verdict;
  try {
    verdict = JSON.parse(raw) as Verdict;
  } catch {
    throw new Error(`verifier ${engine}: verdict JSON malformato per PR #${prNumber}`);
  }
  if (verdict.decision !== 'APPROVE' && verdict.decision !== 'REQUEST_CHANGES') {
    throw new Error(`verifier ${engine}: decision non valida per PR #${prNumber}: ${JSON.stringify(verdict?.decision)}`);
  }
  if (typeof verdict.criticalPathHit !== 'boolean') {
    throw new Error(
      `verifier ${engine}: criticalPathHit mancante/non-boolean per PR #${prNumber} — verdict rifiutato (fail-closed sul gate critico)`,
    );
  }
  if (typeof verdict.rationale !== 'string' || !verdict.rationale.trim()) {
    throw new Error(`verifier ${engine}: rationale mancante per PR #${prNumber}`);
  }
  verdict.comments ??= [];
  verdict.attribution = { engine, ...(model ? { model } : {}) };
  return verdict;
}
