import { expect, test } from '@playwright/test';

/**
 * The whole product in one pass, as a person does it: make an account, point it at a list, build a
 * robot without a model, run it, and see the run in its history.
 *
 * "Without a model" is deliberate — the model half is judged by the quality gate, which the unit suite
 * covers, and a test that spends money and depends on somebody's API being up is a test people learn
 * to ignore.
 */
const SITE = 'http://127.0.0.1:5610/';

test('an account is made, a robot is built, run, and remembered', async ({ page }) => {
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

  // A robot that was built is a robot that exists.
  const card = page.locator('.robot', { hasText: 'fixture-jobs' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('127.0.0.1:5610');

  // And running it returns rows from the site, not a promise of them.
  await card.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('page(s)', { timeout: 60_000 });
  await expect(page.locator('#result table')).toBeVisible();
  await expect(page.locator('#result')).toContainText('Madrid');

  // The run left a mark: the product's claim is that a robot says how it is doing.
  await page.click('.view-tab[data-view="runs"]');
  await expect(page.locator('#runsStatus')).toContainText('robots');
  await expect(page.locator('#runsList')).toContainText('fixture-jobs');
  await expect(page.locator('#runsList')).toContainText('ok');
});

test('a robot card says how the robot is doing, not just what it is', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `second-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'standing-check');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('standing-check', { timeout: 60_000 });

  const card = page.locator('.robot', { hasText: 'standing-check' });
  await expect(card).toContainText('never run here');

  // "page(s)" belongs to a run and to nothing else: the draft above also says "rows", and waiting for
  // a word the previous answer already contains is how a test passes while nothing has happened.
  await card.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('page(s)', { timeout: 60_000 });

  await page.reload();
  await expect(page.locator('.robot', { hasText: 'standing-check' })).toContainText('rows');
});

test('what one account keeps, another cannot see', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `third-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await expect(page.locator('#robots')).toBeVisible();
  await expect(page.locator('.robot', { hasText: 'fixture-jobs' })).toHaveCount(0);
});

test('deleting a robot asks first, and then it is gone', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `fourth-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'doomed');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('doomed', { timeout: 60_000 });

  const card = page.locator('.robot', { hasText: 'doomed' });
  const remove = card.getByRole('button', { name: 'Delete' });

  // One press only asks. A robot is minutes of work; it should take two to lose it.
  await remove.click();
  await expect(card.getByRole('button', { name: 'really?' })).toBeVisible();
  await expect(page.locator('.robot', { hasText: 'doomed' })).toBeVisible();

  await card.getByRole('button', { name: 'really?' }).click();
  await expect(page.locator('#result')).toContainText('deleted', { timeout: 30_000 });
  await expect(page.locator('.robot', { hasText: 'doomed' })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.robot', { hasText: 'doomed' })).toHaveCount(0);
});

test('a robot built from a page can be given a rule, tried, and kept', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `fifth-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'sifted');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('sifted', { timeout: 60_000 });

  // A rule is the same thing for a page as for a message stream: what counts, and what does not.
  await page.locator('.robot', { hasText: 'sifted' }).getByRole('button', { name: 'Rule' }).click();
  await expect(page.locator('#ruleKeep')).toBeVisible();

  await page.fill('#ruleKeep', 'Madrid\nBarcelona');
  await page.click('[data-rule-test="sifted"]');
  await expect(page.locator('#ruleOut')).toContainText('kept', { timeout: 60_000 });
  await expect(page.locator('#ruleOut')).toContainText('Madrid');

  await page.click('[data-rule-save="sifted"]');
  await expect(page.locator('#ruleOut')).toContainText('saved', { timeout: 30_000 });

  // And now the robot returns only what the rule allows.
  await page.locator('.robot', { hasText: 'sifted' }).getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('#result')).toContainText('page(s)', { timeout: 60_000 });
  await expect(page.locator('#result')).toContainText('Madrid');
  await expect(page.locator('#result table')).not.toContainText('Valencia');
});

test('a robot that remembers hands back only what it has not seen', async ({ page }) => {
  await page.goto('/');
  await page.fill('#authEmail', `sixth-${Date.now()}@example.com`);
  await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authRegister');

  await page.fill('#url', SITE);
  await page.fill('#name', 'remembers');
  await page.click('#draft');
  await expect(page.locator('#resultTitle')).toContainText('remembers', { timeout: 60_000 });

  const card = page.locator('.robot', { hasText: 'remembers' });
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
