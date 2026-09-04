import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

/**
 * Buttons that do nothing.
 *
 * This is the failure the front-end keeps producing: markup grows a `data-something` button, the
 * handler for it is never written or is renamed on one side only, and the page answers a click with
 * silence. Nothing else in this suite can see it — the markup is valid, the API works, and the click
 * goes nowhere. So the two sides are compared here, as text, on every run.
 *
 * It also insists that every handler puts something on the screen. A handler that awaits an answer and
 * then renders nothing is the same bug wearing a different hat — that is exactly how “Check connection”
 * came to ask Telegram and change nothing.
 */
const app = await readFile(new URL('../web/app.ts', import.meta.url), 'utf8');
const render = await readFile(new URL('../web/render.ts', import.meta.url), 'utf8');

/** Attributes the markup puts on a control: `data-tg-check="…"` and friends. */
function emitted(source) {
  return new Set([...source.matchAll(/data-([a-z0-9-]+)="\$\{/g)].map((match) => match[1]));
}

/** Attributes app.ts actually listens for, whether through the action table or by hand. */
function handled(source) {
  return new Set([
    ...[...source.matchAll(/\['data-([a-z0-9-]+)',/g)].map((match) => match[1]),
    ...[...source.matchAll(/getAttribute\('data-([a-z0-9-]+)'\)/g)].map((match) => match[1]),
    ...[...source.matchAll(/\[data-([a-z0-9-]+)[=\]]/g)].map((match) => match[1]),
    ...[...source.matchAll(/dataset\['([a-zA-Z0-9]+)'\]/g)].map((match) => camelToDashed(match[1])),
  ]);
}

function actionTable() {
  return app.slice(app.indexOf('const actions:'), app.indexOf('for (const [attribute, where, run] of actions)'));
}

function camelToDashed(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

test('every control the markup emits has something listening for it', () => {
  const listening = handled(app);
  const orphans = [...emitted(render), ...emitted(app)].filter((attribute) => !listening.has(attribute));
  assert.deepEqual(orphans, [], `these controls do nothing when pressed: ${orphans.join(', ')}`);
});

test('every action puts its answer on the screen', () => {
  // The action table: ['data-x', 'whereToComplain', async (id) => { … }] — split on entries rather
  // than matched as a whole, because the handler bodies have braces of their own.
  const entries = actionTable().split(/\['data-/).slice(1);
  assert.ok(entries.length >= 9, `expected the whole action table, saw ${entries.length} entries`);

  for (const entry of entries) {
    const attribute = entry.slice(0, entry.indexOf("'"));
    // The three ways this interface has of showing something: writing into a panel, re-reading a list,
    // or handing the result box a verdict.
    const shows =
      /\binnerHTML\s*=/.test(entry) ||
      /\bload[A-Z]\w*\(/.test(entry) ||
      /\bresult\(/.test(entry) ||
      /\b(runScraper|repairScraper|handOver)\(/.test(entry);
    assert.ok(shows, `data-${attribute} does its work and then changes nothing on the page`);
  }
});

test('the action table complains to an element that exists', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const [, attribute, where] of actionTable().matchAll(/\['data-([a-z0-9-]+)', '([a-zA-Z]+)',/g)) {
    assert.ok(
      html.includes(`id="${where}"`),
      `data-${attribute} reports failures into #${where}, which the page does not have`,
    );
  }
});
