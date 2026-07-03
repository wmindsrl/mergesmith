// Recap: a scannable snapshot of the loop's state for Slack — open agent-managed PRs (by state),
// issues waiting/working/to-triage. On-demand via `mergesmith recap`; schedule a cron for a daily one.
import type { LabelConfig, MergesmithConfig } from './config.js';
import { listOpenIssuesWithLabel, listOpenPRs, type OpenPR } from './github.js';
import { getImplementer } from './providers/registry.js';
import { postSlack } from './slack.js';
import { knownBranches } from './orchestrator/state.js';

export interface RecapPR {
  number: number;
  branch: string;
  state: string;
}

export interface RecapData {
  repo: string;
  prs: RecapPR[];
  ready: number[];
  inProgress: number[];
  needsTriage: number[];
}

// PR state derived from labels, most-blocking first (a PR can carry several).
export function prState(labels: string[], L: LabelConfig): string {
  if (labels.includes(L.needsHuman)) return '🔴 needs-human';
  if (labels.includes(L.rework)) return '🔧 rework';
  if (labels.includes(L.ciRed)) return '🟠 ci-red';
  if (labels.includes(L.approved)) return '✅ approved';
  return '👀 in review';
}

function isManaged(pr: OpenPR, branchPrefix: string, known: Set<string>): boolean {
  return pr.headRefName.startsWith(branchPrefix) || known.has(pr.headRefName);
}

export function formatRecap(data: RecapData): string {
  const lines: string[] = [`:clipboard: *Mergesmith recap — ${data.repo}*`];

  if (data.prs.length > 0) {
    lines.push('', `*PR gestite (${data.prs.length})*`);
    for (const pr of data.prs) lines.push(`• #${pr.number} \`${pr.branch}\` — ${pr.state}`);
  }

  const issueLine = (emoji: string, label: string, nums: number[]): void => {
    if (nums.length > 0) lines.push(`${emoji} *${label}* (${nums.length}): ${nums.map((n) => `#${n}`).join(', ')}`);
  };
  if (data.ready.length + data.inProgress.length + data.needsTriage.length > 0) {
    lines.push('', '*Issue*');
    issueLine(':inbox_tray:', 'pronte', data.ready);
    issueLine(':hammer_and_wrench:', 'in lavorazione', data.inProgress);
    issueLine(':mag:', 'da triage', data.needsTriage);
  }

  if (data.prs.length === 0 && data.ready.length + data.inProgress.length + data.needsTriage.length === 0) {
    lines.push('', '_Niente in coda: nessuna PR gestita, nessuna issue aperta._');
  }
  return lines.join('\n');
}

export function gatherRecap(config: MergesmithConfig): RecapData {
  const branchPrefix = getImplementer(config).branchPrefix;
  const known = new Set(knownBranches(config.repo));
  const prs = listOpenPRs(config)
    .filter((pr) => !pr.isDraft && isManaged(pr, branchPrefix, known))
    .map((pr) => ({ number: pr.number, branch: pr.headRefName, state: prState(pr.labels, config.labels) }));

  return {
    repo: config.repo,
    prs,
    ready: listOpenIssuesWithLabel(config, config.issues.ready),
    inProgress: listOpenIssuesWithLabel(config, config.issues.inProgress),
    needsTriage: listOpenIssuesWithLabel(config, config.issues.needsTriage),
  };
}

export async function postRecap(config: MergesmithConfig): Promise<void> {
  await postSlack(config.slack, formatRecap(gatherRecap(config)));
}
