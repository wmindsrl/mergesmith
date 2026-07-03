import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrigger,
  stripTrigger,
  allowedToTrigger,
  extractIssueJson,
  renderThread,
  buildSynthPrompt,
} from '../src/inbox.ts';

test('isTrigger: bare, padded, inline, case-insensitive; rejects non-triggers', () => {
  assert.equal(isTrigger('!go', '!go'), true);
  assert.equal(isTrigger('  !go  ', '!go'), true);
  assert.equal(isTrigger('!go move the link', '!go'), true);
  assert.equal(isTrigger('!GO', '!go'), true);
  assert.equal(isTrigger('go', '!go'), false);
  assert.equal(isTrigger('let!go now', '!go'), false);
  assert.equal(isTrigger('!going', '!go'), false); // needs a word boundary after the token
  assert.equal(isTrigger(undefined, '!go'), false);
  assert.equal(isTrigger('/ship it', '/ship'), true); // custom trigger
});

test('stripTrigger: removes only a leading trigger token', () => {
  assert.equal(stripTrigger('!go move the link', '!go'), 'move the link');
  assert.equal(stripTrigger('!go', '!go'), '');
  assert.equal(stripTrigger('no trigger here', '!go'), 'no trigger here');
  assert.equal(stripTrigger('keep !go in the middle', '!go'), 'keep !go in the middle');
});

test('allowedToTrigger: only listed user ids', () => {
  assert.equal(allowedToTrigger('U1', ['U1', 'U2']), true);
  assert.equal(allowedToTrigger('U9', ['U1', 'U2']), false);
  assert.equal(allowedToTrigger(undefined, ['U1']), false);
  assert.equal(allowedToTrigger('U1', []), false);
});

test('extractIssueJson: pulls a valid object out of surrounding prose', () => {
  const out = 'Ecco la issue:\n{"title": "Sposta il link", "body": "Contesto e criteri"}\nFine.';
  assert.deepEqual(extractIssueJson(out), { title: 'Sposta il link', body: 'Contesto e criteri' });
});

test('extractIssueJson: handles braces and escaped quotes inside strings', () => {
  const out = '{"title": "Fix {bug}", "body": "dice \\"ciao\\" e una }graffa"}';
  assert.deepEqual(extractIssueJson(out), { title: 'Fix {bug}', body: 'dice "ciao" e una }graffa' });
});

test('extractIssueJson: null on missing field / non-JSON', () => {
  assert.equal(extractIssueJson('{"title": "solo titolo"}'), null); // no body
  assert.equal(extractIssueJson('{"title": "", "body": "x"}'), null); // empty title
  assert.equal(extractIssueJson('nessun json qui'), null);
  assert.equal(extractIssueJson('{non valido}'), null);
});

test('renderThread: strips triggers, drops bare-trigger lines, credits names', () => {
  const names = new Map([
    ['U1', 'Marco'],
    ['U2', 'Selene'],
  ]);
  const messages = [
    { ts: '1', user: 'U1', text: 'Il link WMS è nel posto sbagliato' },
    { ts: '2', user: 'U2', text: 'Sì, spostiamolo sotto Dashboard' },
    { ts: '3', user: 'U1', text: '!go' }, // bare trigger → dropped
  ];
  assert.equal(
    renderThread(messages, names, '!go'),
    'Marco: Il link WMS è nel posto sbagliato\nSelene: Sì, spostiamolo sotto Dashboard',
  );
});

test('renderThread: inline "!go <content>" keeps the content', () => {
  const names = new Map([['U1', 'Marco']]);
  const messages = [{ ts: '1', user: 'U1', text: '!go sposta il link in alto' }];
  assert.equal(renderThread(messages, names, '!go'), 'Marco: sposta il link in alto');
});

test('buildSynthPrompt: embeds the discussion and asks for JSON only', () => {
  const p = buildSynthPrompt('Marco: sposta il link');
  assert.match(p, /Marco: sposta il link/);
  assert.match(p, /"title"/);
  assert.match(p, /SOLO/);
});
