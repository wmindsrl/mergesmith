// Slack → GitHub issue. A channel message + its thread is where a bug/feature gets discussed;
// an allowed user replies with the trigger (default "!go") to finalize it. On the next poll we
// read the thread, synthesize a clean issue (LLM), create it labelled `ready` (→ the tick
// dispatches it), react + reply in-thread with the link, and credit the humans involved.
// Poll-based: no inbound server, symmetric with the rest of the loop.
import type { MergesmithConfig } from './config.js';
import { createIssue } from './github.js';
import { loadEnvVarOptional } from './lib.js';
import { getVerifier } from './providers/registry.js';
import {
  addReaction,
  getPermalink,
  postSlack,
  readChannelHistory,
  readThreadReplies,
  resolveChannel,
  resolveUserName,
  type SlackMessage,
} from './slack.js';
import {
  getInboxCursor,
  isThreadProcessed,
  markThreadProcessed,
  setInboxCursor,
} from './orchestrator/state.js';

// ---- pure helpers (unit-tested) ----

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A message finalizes a thread if it starts with the trigger token (bare "!go" or "!go <text>"). */
export function isTrigger(text: string | undefined, trigger: string): boolean {
  if (!text) return false;
  return new RegExp(`^${escapeRegExp(trigger)}(\\s|$)`, 'i').test(text.trim());
}

/** Remove a leading trigger token so "!go move the link" contributes "move the link" as content. */
export function stripTrigger(text: string, trigger: string): string {
  return text.replace(new RegExp(`^${escapeRegExp(trigger)}\\s*`, 'i'), '').trim();
}

export function allowedToTrigger(userId: string | undefined, allowed: string[]): boolean {
  return !!userId && allowed.includes(userId);
}

// First balanced {...} in the model's stdout, parsed + validated to {title, body}.
export function extractIssueJson(stdout: string): { title: string; body: string } | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(stdout.slice(start, i + 1)) as { title?: unknown; body?: unknown };
          if (
            typeof parsed.title === 'string' &&
            parsed.title.trim() &&
            typeof parsed.body === 'string' &&
            parsed.body.trim()
          ) {
            return { title: parsed.title.trim(), body: parsed.body };
          }
        } catch {
          /* not valid JSON */
        }
        return null;
      }
    }
  }
  return null;
}

export function renderThread(
  messages: SlackMessage[],
  nameByUser: Map<string, string>,
  trigger: string,
): string {
  return messages
    .map((m) => ({
      name: nameByUser.get(m.user ?? '') ?? m.user ?? 'utente',
      text: stripTrigger(m.text ?? '', trigger),
    }))
    .filter((m) => m.text)
    .map((m) => `${m.name}: ${m.text}`)
    .join('\n');
}

export function buildSynthPrompt(threadText: string): string {
  return [
    'Sei un tech lead. Trasforma questa discussione Slack in una issue GitHub pulita e implementabile.',
    'Scrivi in italiano. Sii conciso e concreto: contesto, cosa fare, criteri di accettazione.',
    '',
    'Discussione (dal più vecchio al più recente):',
    threadText,
    '',
    'Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, nel formato:',
    '{"title": "<titolo conciso, imperativo>", "body": "<corpo markdown>"}',
  ].join('\n');
}

// ---- orchestration ----

export async function pollInbox(config: MergesmithConfig): Promise<void> {
  const { inbox } = config.slack;
  if (!inbox.enabled) return;

  const channel = resolveChannel(config.slack);
  const mentionId = config.slack.mentionUserIdEnv ? loadEnvVarOptional(config.slack.mentionUserIdEnv) : null;
  const allowed = inbox.allowedUsers.length > 0 ? inbox.allowedUsers : mentionId ? [mentionId] : [];
  if (allowed.length === 0) {
    console.warn('inbox: nessun utente autorizzato (slack.inbox.allowedUsers vuoto e mention user assente) — skip');
    return;
  }

  const history = await readChannelHistory(config.slack, channel);
  const newest = (m: SlackMessage): number => Number(m.latest_reply ?? m.ts);
  const highWater = history.reduce((max, m) => Math.max(max, newest(m)), 0);

  const cursor = getInboxCursor(config.repo);
  if (cursor === undefined) {
    // Bootstrap: adopt the current high-water mark WITHOUT acting, so enabling the inbox never
    // floods on historical !go messages. Only triggers newer than this count from here on.
    const seed = highWater > 0 ? String(highWater) : (Date.now() / 1000).toFixed(6);
    setInboxCursor(config.repo, seed);
    console.log(`inbox: bootstrap cursor=${seed} (nessuna azione sui messaggi storici)`);
    return;
  }

  for (const root of history) {
    if (isThreadProcessed(config.repo, root.ts)) continue;
    if (newest(root) <= Number(cursor)) continue; // nothing new in this thread since last poll

    const thread =
      root.reply_count && root.reply_count > 0
        ? await readThreadReplies(config.slack, channel, root.ts)
        : [root];

    const triggerMsg = thread.find(
      (m) => isTrigger(m.text, inbox.trigger) && allowedToTrigger(m.user, allowed) && Number(m.ts) > Number(cursor),
    );
    if (!triggerMsg) continue;

    try {
      await finalizeThread(config, channel, root, thread, triggerMsg);
    } catch (error) {
      console.error(`inbox: thread ${root.ts} fallito: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (highWater > 0) setInboxCursor(config.repo, String(highWater));
}

async function finalizeThread(
  config: MergesmithConfig,
  channel: string,
  root: SlackMessage,
  thread: SlackMessage[],
  triggerMsg: SlackMessage,
): Promise<void> {
  await addReaction(config.slack, channel, triggerMsg.ts, 'eyes'); // 👀 taken

  const userIds = [...new Set(thread.map((m) => m.user).filter((u): u is string => !!u))];
  const nameByUser = new Map<string, string>();
  for (const id of userIds) nameByUser.set(id, await resolveUserName(config.slack, id));

  const threadText = renderThread(thread, nameByUser, config.slack.inbox.trigger);
  const reporter = nameByUser.get(root.user ?? '') ?? 'un membro del team';
  const finalizer = nameByUser.get(triggerMsg.user ?? '') ?? reporter;
  const permalink = await getPermalink(config.slack, channel, root.ts);

  const verifier = getVerifier(config);
  let issue: { title: string; body: string } | null = null;
  if (verifier.synthesize) {
    try {
      issue = extractIssueJson(await verifier.synthesize(buildSynthPrompt(threadText)));
    } catch (error) {
      console.error(`inbox: sintesi LLM fallita: ${String(error)}`);
    }
  }
  const degraded = issue === null;
  if (!issue) {
    // Never lose the work: fall back to a raw issue and flag the degradation (no silent failure).
    const firstLine = (stripTrigger(root.text ?? '', config.slack.inbox.trigger) || 'Richiesta da Slack')
      .split('\n')[0]!
      .slice(0, 80);
    issue = { title: firstLine, body: threadText || firstLine };
  }

  const footer = [
    '',
    '---',
    `_Issue creata da Mergesmith da una discussione Slack — segnalata da ${reporter}, finalizzata da ${finalizer}.${permalink ? ` ${permalink}` : ''}_`,
  ].join('\n');
  const number = createIssue(config, issue.title, `${issue.body}${footer}`, [config.issues.ready]);
  markThreadProcessed(config.repo, root.ts);

  const url = `https://github.com/${config.repo}/issues/${number}`;
  await addReaction(config.slack, channel, triggerMsg.ts, 'white_check_mark');
  const note = degraded ? ' (sintesi LLM non disponibile: issue grezza, rivedila)' : '';
  await postSlack(config.slack, `:white_check_mark: Issue #${number} creata: ${url}${note} — la lavoro a breve.`, {
    threadTs: root.ts,
  });
}
