// Slack integration. Channel/token/mention resolved from config + env (values never in config).
import { buildSlackText, loadEnvVar, loadEnvVarOptional } from './lib.js';
import type { SlackConfig } from './config.js';

export interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reactions?: Array<{ name: string; users?: string[] }>;
}

export interface PostResult {
  ts: string;
  channel: string;
}

export function resolveChannel(slack: SlackConfig, override?: string): string {
  const channel =
    override ?? slack.channel ?? (slack.channelEnv ? loadEnvVarOptional(slack.channelEnv) : null);
  if (!channel) {
    throw new Error(
      `Slack channel non configurato: imposta slack.channel oppure ${slack.channelEnv} nell'ambiente/.env.local`,
    );
  }
  return channel;
}

// Generic Web API call, fail-loud on {ok:false}.
async function slackApi<T = Record<string, unknown>>(
  slack: SlackConfig,
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: boolean }> {
  const token = loadEnvVar(slack.botTokenEnv);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack ${method} fallita: ${data.error ?? res.status}`);
  return data;
}

// Post a message (optionally threaded / with a mention). Returns the message ts + channel so
// callers can thread subsequent events. Backward-compatible: `await postSlack(...)` still works.
export async function postSlack(
  slack: SlackConfig,
  text: string,
  opts?: { mention?: boolean; threadTs?: string },
): Promise<PostResult> {
  const channel = resolveChannel(slack);
  const userId = slack.mentionUserIdEnv ? loadEnvVarOptional(slack.mentionUserIdEnv) : null;
  const finalText = buildSlackText(text, opts?.mention ?? false, userId);
  const body: Record<string, unknown> = { channel, text: finalText };
  if (opts?.threadTs) body.thread_ts = opts.threadTs;
  const data = await slackApi<{ ts: string }>(slack, 'chat.postMessage', body);
  return { ts: data.ts, channel };
}

export async function addReaction(slack: SlackConfig, channel: string, ts: string, name: string): Promise<void> {
  try {
    await slackApi(slack, 'reactions.add', { channel, timestamp: ts, name });
  } catch (error) {
    if (!String(error).includes('already_reacted')) throw error; // already-reacted is fine
  }
}

export async function getPermalink(slack: SlackConfig, channel: string, ts: string): Promise<string | null> {
  try {
    const data = await slackApi<{ permalink: string }>(slack, 'chat.getPermalink', {
      channel,
      message_ts: ts,
    });
    return data.permalink;
  } catch {
    return null;
  }
}

// Channel messages since `oldest` (exclusive). Used by the issue inbox poll.
export async function readChannelHistory(
  slack: SlackConfig,
  channel: string,
  oldest?: string,
): Promise<SlackMessage[]> {
  const body: Record<string, unknown> = { channel, limit: 200 };
  if (oldest) body.oldest = oldest;
  const data = await slackApi<{ messages: SlackMessage[] }>(slack, 'conversations.history', body);
  return data.messages ?? [];
}

// All replies in a thread (root included). Used to synthesize an issue from a discussion.
export async function readThreadReplies(
  slack: SlackConfig,
  channel: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const data = await slackApi<{ messages: SlackMessage[] }>(slack, 'conversations.replies', {
    channel,
    ts: threadTs,
    limit: 200,
  });
  return data.messages ?? [];
}
