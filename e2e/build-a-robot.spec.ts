import { expect, test } from '@playwright/test';

/**
 * The whole product in one pass, as a person does it: make an account, point it at a list, build a
 * scraper without a model, run it, and see the run in its history.
 *
 * "Without a model" is deliberate — the model half is judged by the quality gate, which the unit suite
 * covers, and a test that spends money and depends on somebody's API being up is a test people learn
 * to ignore.
 */
const SITE = 'http://127.0.0.1:5610/';

test('an account is made, a scraper is built, run, and remembered', async ({ page }) => {
  await page.goto('/');

  // Nobody is signed in yet, so the only thing on offer is signing in.
  await expect(page.locator('#authBox')).toBeVisible();
  const email = `first-${Date.now()}@example.com`;
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await expect(page.locator('nav#views')).toBeVisible();
  await expect(page.locator('#who')).toContainText(email);

  // Build it from plain rules: instant, free, and enough for a list this obvious.
  await page.fill('#url', SITE);
  await page.fill('#name', 'fixture-jobs');
  await page.click('#draft');

  await expect(page.locator('#resultTitle')).toContainText('fixture-jobs', { timeout: 60_000 });
  await expect(page.locator('#result')).toContainText('proven on');

  // A scraper that was built is a scraper that exists.
  const card = page.locator('.item', { hasText: 'fixture-jobs' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('127.0.0.1:5610');

  // And running it returns rows from the site, not a promise of them.
  await card.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('page(s)', { timeout: 60_000 });
  await expect(page.locator('#result table')).toBeVisible();
  await expect(page.locator('#result')).toContainText('Madrid');

  // The run left a mark: the product's claim is that a scraper says how it is doing.
  await page.click('.view-tab[data-view="runs"]');
  await expect(page.locator('#runsStatus')).toContainText('scrapers');
  await expect(page.locator('#runsList')).toContainText('fixture-jobs');
  await expect(page.locator('#runsList')).toContainText('ok');
});

test('a scraper card says how the scraper is doing, not just what it is', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `second-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'standing-check');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('standing-check', { timeout: 60_000 });

  const card = page.locator('.item', { hasText: 'standing-check' });
  await expect(card).toContainText('never run here');

  // "page(s)" belongs to a run and to nothing else: the draft above also says "rows", and waiting for
  // a word the previous answer already contains is how a test passes while nothing has happened.
  await card.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('page(s)', { timeout: 60_000 });

  await page.reload();
  await expect(page.locator('.item', { hasText: 'standing-check' })).toContainText('rows');
});

test('what one account keeps, another cannot see', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `third-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await expect(page.locator('#scrapers')).toBeVisible();
  await expect(page.locator('.item', { hasText: 'fixture-jobs' })).toHaveCount(0);
});

test('deleting a scraper asks first, and then it is gone', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `fourth-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'doomed');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('doomed', { timeout: 60_000 });

  const card = page.locator('.item', { hasText: 'doomed' });
  const remove = card.getByRole('button', { name: 'Delete' });

  // One press only asks. A scraper is minutes of work; it should take two to lose it.
  await remove.click();
  await expect(card.getByRole('button', { name: 'really?' })).toBeVisible();
  await expect(page.locator('.item', { hasText: 'doomed' })).toBeVisible();

  await card.getByRole('button', { name: 'really?' }).click();
  await expect(page.locator('#result')).toContainText('deleted', { timeout: 30_000 });
  await expect(page.locator('.item', { hasText: 'doomed' })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.item', { hasText: 'doomed' })).toHaveCount(0);
});

test('a scraper built from a page can be given a rule, tried, and kept', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `fifth-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'sifted');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('sifted', { timeout: 60_000 });

  // A rule is the same thing for a page as for a message stream: what counts, and what does not.
  await page.locator('.item', { hasText: 'sifted' }).getByRole('button', { name: 'Rule' }).click();
  await expect(page.locator('#ruleKeep')).toBeVisible();

  await page.fill('#ruleKeep', 'Madrid\nBarcelona');
  await page.click('[data-rule-test="sifted"]');
  await expect(page.locator('#ruleOut')).toContainText('kept', { timeout: 60_000 });
  await expect(page.locator('#ruleOut')).toContainText('Madrid');

  await page.click('[data-rule-save="sifted"]');
  await expect(page.locator('#ruleOut')).toContainText('saved', { timeout: 30_000 });

  // And now the scraper returns only what the rule allows.
  await page.locator('.item', { hasText: 'sifted' }).getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('page(s)', { timeout: 60_000 });
  await expect(page.locator('#result')).toContainText('Madrid');
  await expect(page.locator('#result table')).not.toContainText('Valencia');
});

test('a scraper that remembers hands back only what it has not seen', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `sixth-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'remembers');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('remembers', { timeout: 60_000 });

  const card = page.locator('.item', { hasText: 'remembers' });
  await card.getByRole('button', { name: 'Rule' }).click();
  await page.check('#ruleRemember');
  await page.click('[data-rule-save="remembers"]');
  await expect(page.locator('#ruleOut')).toContainText('not seen before', { timeout: 30_000 });

  // The site has not changed between these two runs, so the second one has nothing to say — and that
  // is a quiet day, not an empty source and not a broken robot.
  await card.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('page(s)', { timeout: 60_000 });
  await expect(page.locator('#result')).toContainText('Madrid');

  await card.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('seen before', { timeout: 60_000 });
  await expect(page.locator('#result')).not.toContainText('Madrid');
});

test('a scraper can be checked without running it, and says what it found', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `seventh-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'checkable');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('checkable', { timeout: 60_000 });

  const card = page.locator('.item', { hasText: 'checkable' });
  await expect(card).toContainText('never run here');

  // The question every card answers the same way: one page, no model, nothing remembered.
  await card.locator('button[data-scraper-check]').click();
  await expect(card.locator('.state.ok')).toContainText('rows on the first page', { timeout: 60_000 });

  // …and a check is not a run: it leaves the history alone, or "three runs in a row" would mean nothing.
  await page.click('.view-tab[data-view="runs"]');
  await expect(page.locator('#runsList')).not.toContainText('checkable');
});
