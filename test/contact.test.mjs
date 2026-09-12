import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';

import { forgetContacts, phoneIn, remembered, revealPhone } from '../src/contact.ts';

/**
 * A board shows the number only to someone who asks for it. The trap is not the click — it is what
 * happens when the click does nothing: a page is full of numbers, and a loose reading turns a failed
 * reveal into a confident wrong number, which is worse than an empty field.
 */
beforeEach(() => forgetContacts());

const LISTING = 'https://example.test/134586074.htm';

/** A page that behaves like theirs: masked until pressed, then the control says the number itself. */
function listing({ pressable = true, revealsTo = 'Hiện số 0899680413', wall = null } = {}) {
  const state = { pressed: false, opened: 0, waits: 0 };
  const page = {
    goto: async () => { state.opened++; },
    currentUrl: async () => LISTING,
    waitMs: async () => { state.waits++; },
    click: async () => {},
    evaluate: async (fn) => {
      if (fn.includes('document.title')) return wall;
      if (fn.includes('target.click()')) {
        if (!pressable) return false;
        state.pressed = true;
        return true;
      }
      return state.pressed ? revealsTo : 'Hiện số 089968 ***';
    },
  };
  return { page, state };
}

test('a number is read only after the control has been pressed', async () => {
  const { page, state } = listing();

  const got = await revealPhone(page, LISTING, { clickText: 'Hiện số' });

  assert.equal(got.phone, '0899680413');
  assert.equal(state.pressed, true);
  assert.equal(state.opened, 1);
});

test('a control that is not there is said out loud, not returned as a blank', async () => {
  const { page } = listing({ pressable: false });

  const got = await revealPhone(page, LISTING, { clickText: 'Hiện số' });

  assert.equal(got.phone, null);
  assert.match(got.reason, /nothing on the page says/);
});

test('a press that reveals nothing does not invent a number out of the page', async () => {
  // The masked form is still on the control. Reading it loosely would hand back 089968 as a phone.
  const { page } = listing({ revealsTo: 'Hiện số 089968 ***' });

  const got = await revealPhone(page, LISTING, { clickText: 'Hiện số' });

  assert.equal(got.phone, null, 'a mask is not a number');
  assert.match(got.reason, /still shows no number/);
});

test('the board is not asked twice for the same listing', async () => {
  const first = listing();
  await revealPhone(first.page, LISTING, { clickText: 'Hiện số' });
  const second = listing();
  const again = await revealPhone(second.page, LISTING, { clickText: 'Hiện số' });

  assert.equal(again.phone, '0899680413');
  assert.equal(second.state.opened, 0, 'the answer was already in hand');
});

test('an answer kept since yesterday is not an answer', async () => {
  const day = 24 * 60 * 60 * 1000;
  const { page } = listing();
  await revealPhone(page, LISTING, { clickText: 'Hiện số', now: 1_000_000 });

  assert.equal(remembered(LISTING, 1_000_000 + day), undefined, 'a re-let is not called about');
});

test('only a number shaped like a number is one', () => {
  assert.equal(phoneIn('Hiện số 0899680413'), '0899680413');
  assert.equal(phoneIn('0899 680 413'), '0899680413', 'people space them out');
  assert.equal(phoneIn('Hiện số 089968 ***'), null, 'the mask');
  assert.equal(phoneIn('13.000.000 đ/tháng'), null, 'a price is not a phone');
  assert.equal(phoneIn('85 m² · 3 PN'), null);
  assert.equal(phoneIn(null), null);
});

test('a check standing in the way is a door, not a missing button', async () => {
  // Cloudflare answers with its own page. Reporting that as "no such control" sends somebody to fix a
  // selector that was never wrong, and hides the one thing that would actually help: walking through.
  const { page } = listing({ pressable: false, wall: 'Just a moment...' });

  const got = await revealPhone(page, LISTING, { clickText: 'Hiện số' });

  assert.equal(got.phone, null);
  assert.equal(got.door, 'Just a moment...');
  assert.match(got.reason, /prove we are human/);
});

test('a door is not remembered as an answer', async () => {
  const blocked = listing({ pressable: false, wall: 'Just a moment...' });
  await revealPhone(blocked.page, LISTING, { clickText: 'Hiện số' });

  // Once somebody has walked through it, asking again must actually ask again.
  const open_ = listing();
  const got = await revealPhone(open_.page, LISTING, { clickText: 'Hiện số' });
  assert.equal(got.phone, '0899680413');
  assert.equal(open_.state.opened, 1, 'the board was asked again, not answered from a cached refusal');
});
