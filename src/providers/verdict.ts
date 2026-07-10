// Shared verdict read + FAIL-CLOSED validation for verifier providers.
// The review CLI (claude / agent) writes a verdict file in cwd. The PR number is part of the
// slash-command argument, so the command can (and should) write a PER-PR file
// (mergesmith-verdict-<pr>.json): concurrent verifies never clobber each other. The legacy
// un-suffixed file is still read as a fallback for not-yet-updated commands / manual runs.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RereviewContext, Verdict } from './types.js';

export const VERDICT_FILE = 'mergesmith-verdict.json';

export function verdictPath(cwd: string, prNumber?: number): string {
  return join(cwd, prNumber != null ? `mergesmith-verdict-${prNumber}.json` : VERDICT_FILE);
}

export function rereviewPath(cwd: string, prNumber: number): string {
  return join(cwd, `mergesmith-rereview-${prNumber}.json`);
}

/** Materialize the re-review context where the review command reads it (repo root). The file's
 * presence IS the mode switch: the command scopes itself to previous blockers + delta.
 * Returns a cleanup fn — call it in `finally` so a stale context never leaks into a later run. */
export function writeRereviewContext(cwd: string, prNumber: number, ctx: RereviewContext): () => void {
  const path = rereviewPath(cwd, prNumber);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        pr: prNumber,
        previousSha: ctx.sha,
        decision: ctx.verdict.decision,
        rationale: ctx.verdict.rationale,
        comments: ctx.verdict.comments,
        ...(ctx.verdict.followupMessage ? { followupMessage: ctx.verdict.followupMessage } : {}),
        ...(ctx.verdict.question ? { question: ctx.verdict.question } : {}),
        ...(ctx.answer ? { ownerAnswer: ctx.answer } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return () => rmSync(path, { force: true });
}

// Read + validate the verdict the review wrote. FAIL-CLOSED: a malformed/incomplete verdict
// throws (never silently approves). Crucially, a missing/non-boolean `criticalPathHit` is
// rejected, so it can never let a critical-path PR slip past the human gate.
export function readVerdict(cwd: string, prNumber: number, engine: string, model?: string): Verdict {
  const perPr = verdictPath(cwd, prNumber);
  const legacy = join(cwd, VERDICT_FILE);
  const out = existsSync(perPr) ? perPr : legacy;
  if (!existsSync(out)) {
    throw new Error(
      `verifier ${engine}: nessun verdetto per PR #${prNumber} (${perPr} e ${legacy} assenti) — la review non ha scritto il verdict file`,
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
  // FAIL-CLOSED cross-read guard: if the verdict declares which PR it is about (updated
  // commands write "pr": <n>), a mismatch means we picked up another PR's file (legacy
  // shared-file race) — reject rather than apply the wrong verdict.
  const declaredPr = (verdict as { pr?: unknown }).pr;
  if (declaredPr != null && Number(declaredPr) !== prNumber) {
    throw new Error(
      `verifier ${engine}: il verdict letto dichiara PR #${String(declaredPr)} ma era attesa PR #${prNumber} — scartato (race sul file condiviso?)`,
    );
  }
  if (verdict.decision !== 'APPROVE' && verdict.decision !== 'REQUEST_CHANGES' && verdict.decision !== 'NEEDS_DECISION') {
    throw new Error(`verifier ${engine}: decision non valida per PR #${prNumber}: ${JSON.stringify(verdict?.decision)}`);
  }
  // FAIL-CLOSED: a NEEDS_DECISION without a well-formed question can't be asked to the owner —
  // reject it rather than parking the PR with nothing actionable.
  if (verdict.decision === 'NEEDS_DECISION') {
    const q = verdict.question;
    if (!q || typeof q.text !== 'string' || !q.text.trim()) {
      throw new Error(`verifier ${engine}: NEEDS_DECISION senza question.text per PR #${prNumber} — verdict rifiutato`);
    }
    if (q.options != null) {
      const ok =
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        q.options.length <= 4 &&
        q.options.every((o) => typeof o?.key === 'string' && o.key.trim() && typeof o?.label === 'string' && o.label.trim());
      if (!ok) {
        throw new Error(`verifier ${engine}: question.options malformate per PR #${prNumber} (attese 2-4 con key+label)`);
      }
    }
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
