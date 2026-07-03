import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecFrontmatter, parseEnvFile, buildSlackText } from '../src/lib.ts';

const validSpec = `---
id: carrier-zones
branch: feat/carrier-zones
base: main
title: Carrier zones
implementer: composer
---

# Body
`;

test('parseSpecFrontmatter: valid spec', () => {
  assert.deepEqual(parseSpecFrontmatter(validSpec), {
    id: 'carrier-zones',
    branch: 'feat/carrier-zones',
    base: 'main',
    title: 'Carrier zones',
    implementer: 'composer',
  });
});

test('parseSpecFrontmatter: missing frontmatter throws', () => {
  assert.throws(() => parseSpecFrontmatter('# Only body\n'), /frontmatter/i);
});

test('parseSpecFrontmatter: missing required field names the field', () => {
  assert.throws(() => parseSpecFrontmatter(validSpec.replace('base: main\n', '')), /base/);
});

test('parseSpecFrontmatter: invalid implementer throws', () => {
  assert.throws(() => parseSpecFrontmatter(validSpec.replace('implementer: composer', 'implementer: robot')), /implementer/);
});

test('parseEnvFile: comments, blanks and quotes', () => {
  const env = parseEnvFile('# comment\nFOO=bar\n\nBAZ="qux"\nQUOTED=\'v\'\n');
  assert.deepEqual(env, { FOO: 'bar', BAZ: 'qux', QUOTED: 'v' });
});

test('parseEnvFile: value with internal = kept whole', () => {
  assert.deepEqual(parseEnvFile('URL=postgres://u:p@h/db?sslmode=disable\n'), {
    URL: 'postgres://u:p@h/db?sslmode=disable',
  });
});

test('buildSlackText: escapes slack markup on external input', () => {
  assert.equal(buildSlackText('branch <!channel> & <x|y>', false, null), 'branch &lt;!channel&gt; &amp; &lt;x|y&gt;');
});

test('buildSlackText: real mention with id, fallback without', () => {
  assert.equal(buildSlackText('needs review', true, 'U123'), '<@U123> needs review');
  assert.equal(buildSlackText('needs review', true, null), '@here needs review');
});
