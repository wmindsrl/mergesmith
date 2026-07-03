import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, repoSlug, DEFAULT_LABELS } from '../src/config.ts';

function withConfig(json: object, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mergesmith-'));
  try {
    writeFileSync(join(dir, 'mergesmith.config.json'), JSON.stringify(json));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig: applies defaults and keeps required fields', () => {
  withConfig(
    { repo: 'org/app', implementer: { provider: 'cursor' }, verifier: { provider: 'claude-code' } },
    (dir) => {
      const config = loadConfig(dir);
      assert.equal(config.repo, 'org/app');
      assert.equal(config.base, 'main');
      assert.equal(config.ci.workflowName, 'CI');
      assert.equal(config.implementer.branchPrefix, 'cursor/');
      assert.equal(config.implementer.apiKeyEnv, 'CURSOR_API_KEY');
      assert.equal(config.verifier.command, '/validate-pr');
      assert.equal(config.github.tokenEnv, 'GH_TOKEN_MERGESMITH');
      assert.deepEqual(config.labels, DEFAULT_LABELS);
    },
  );
});

test('loadConfig: fail-loud when repo is missing', () => {
  withConfig({ implementer: { provider: 'cursor' }, verifier: { provider: 'claude-code' } }, (dir) => {
    assert.throws(() => loadConfig(dir), /repo/);
  });
});

test('loadConfig: custom labels merge over defaults', () => {
  withConfig(
    {
      repo: 'org/app',
      implementer: { provider: 'cursor' },
      verifier: { provider: 'claude-code' },
      labels: { managed: 'bot' },
    },
    (dir) => {
      const config = loadConfig(dir);
      assert.equal(config.labels.managed, 'bot');
      assert.equal(config.labels.approved, DEFAULT_LABELS.approved);
    },
  );
});

test('repoSlug: filesystem-safe', () => {
  assert.equal(repoSlug('erisesrl/rambase'), 'erisesrl-rambase');
});
