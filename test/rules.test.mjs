import assert from 'node:assert/strict';
import { test } from 'vitest';
import { applyRules } from '../src/rules.ts';

/** A page that answers the two things a rule asks it: what is there, and a press. */
class FakePage {
  constructor() {
    this.pressed = [];
  }
  async currentUrl() { return 'https://example.com/posting/1'; }
  async click(selector) { this.pressed.push(`click:${selector}`); }
  async goto() {}
  async waitMs() {}
  async evaluate(source, argument) {
    if (source.includes('node.click()')) {
      // The page holds one control, and what is written on it is the only way to tell it apart.
      if (argument.selector === 'div[role="button"]' && String(argument.text).toLowerCase() === 'see more') {
        this.pressed.push('pressed:See more');
        return true;
      }
      return false;
    }
    if (source.includes('document.querySelector(selector)')) return argument === '.plain';
    return null;
  }
}

test('a control is pressed by what is written on it', async () => {
  const page = new FakePage();
  const applied = await applyRules(page, [
    { name: 'unfold', match: 'example.com', click: [{ selector: 'div[role="button"]', text: 'See more' }] },
  ]);

  assert.deepEqual(page.pressed, ['pressed:See more']);
  assert.deepEqual(applied, ['unfold: pressed "See more"']);
});

test('a control that says nothing of the sort is left alone', async () => {
  const page = new FakePage();
  const applied = await applyRules(page, [
    { name: 'unfold', match: 'example.com', click: [{ selector: 'div[role="button"]', text: 'Show phone' }] },
  ]);

  assert.deepEqual(page.pressed, []);
  assert.deepEqual(applied, []);
});

test('a plain selector still goes through the driver', async () => {
  const page = new FakePage();
  const applied = await applyRules(page, [{ name: 'banner', match: 'example.com', click: ['.plain', '.absent'] }]);

  assert.deepEqual(page.pressed, ['click:.plain']);
  assert.deepEqual(applied, ['banner: clicked .plain']);
});
