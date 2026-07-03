// Pure, provider-agnostic helpers. No Cursor, no GitHub, no Slack coupling here —
// those live in providers/, github.ts and slack.ts respectively.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ImplementerKind = 'composer' | 'claude' | 'manual';

export interface SpecFrontmatter {
  id: string;
  branch: string;
  base: string;
  title: string;
  implementer: ImplementerKind;
}

const IMPLEMENTERS: readonly ImplementerKind[] = ['composer', 'claude', 'manual'];

export function parseSpecFrontmatter(markdown: string): SpecFrontmatter {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('Spec senza frontmatter: atteso blocco --- ... --- in testa al file');
  }
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+?)\s*(#.*)?$/);
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  for (const required of ['id', 'branch', 'base', 'title', 'implementer']) {
    if (!fields[required]) {
      throw new Error(`Frontmatter: campo obbligatorio "${required}" mancante`);
    }
  }
  if (!IMPLEMENTERS.includes(fields.implementer as ImplementerKind)) {
    throw new Error(
      `Frontmatter: implementer "${fields.implementer}" non valido (ammessi: ${IMPLEMENTERS.join(', ')})`,
    );
  }
  return {
    id: fields.id!,
    branch: fields.branch!,
    base: fields.base!,
    title: fields.title!,
    implementer: fields.implementer as ImplementerKind,
  };
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[kv[1]!] = value;
  }
  return env;
}

// Legge un env var: prima process.env, poi il file .env.local nella root indicata
// (di default la working dir del repo-consumer da cui gira mergesmith).
export function loadEnvVarOptional(name: string, root: string = process.cwd()): string | null {
  const fromProc = process.env[name];
  if (fromProc) return fromProc;
  const envLocalPath = join(root, '.env.local');
  if (existsSync(envLocalPath)) {
    const fileEnv = parseEnvFile(readFileSync(envLocalPath, 'utf8'));
    if (fileEnv[name]) return fileEnv[name]!;
  }
  return null;
}

export function loadEnvVar(name: string, root?: string): string {
  const value = loadEnvVarOptional(name, root);
  if (value) return value;
  throw new Error(`${name} non trovata: esportala nell'ambiente o aggiungila al .env.local del repo`);
}

// Pura e testabile: escape del markup Slack (branch/titoli PR sono input esterno — previene
// <!channel> e link spoofing) + mention reale opzionale (l'@mention testuale non pinga).
export function buildSlackText(text: string, mention: boolean, userId: string | null): string {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!mention) return safe;
  return userId ? `<@${userId}> ${safe}` : `@here ${safe}`;
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
