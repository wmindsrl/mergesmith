// Slack notifier. Channel/token/mention resolved from config + env (values never in config).
import { buildSlackText, loadEnvVar, loadEnvVarOptional } from './lib.js';
import type { SlackConfig } from './config.js';

export async function postSlack(slack: SlackConfig, text: string, opts?: { mention?: boolean }): Promise<void> {
  const token = loadEnvVar(slack.botTokenEnv);
  const channel = slack.channel ?? (slack.channelEnv ? loadEnvVarOptional(slack.channelEnv) : null);
  if (!channel) {
    throw new Error(`Slack channel non configurato: imposta slack.channel oppure ${slack.channelEnv} nell'ambiente/.env.local`);
  }
  const userId = slack.mentionUserIdEnv ? loadEnvVarOptional(slack.mentionUserIdEnv) : null;
  const finalText = buildSlackText(text, opts?.mention ?? false, userId);
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text: finalText }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`Slack chat.postMessage fallita: ${data.error ?? res.status}`);
  }
}
