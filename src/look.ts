import type { PageDriver } from './driver.js';

/**
 * The layer the whole product stands on: what a model is shown instead of the page.
 *
 * Raw markup is hundreds of kilobytes and the model will neither afford it nor read it well. So the
 * platform does the rough structural work itself — find the repeating blocks, propose a selector for
 * each, show what one of them contains, guess which child looks like a title, a price, a date, a link,
 * and say how the page continues — and leaves the model to make the decisions.
 *
 * If an agent ever has to read markup to build a robot, this file failed.
 */
export interface PageSketch {
  url: string;
  title: string;
  /** Repeating blocks, best candidate first. These are the "rows" of the future scenario. */
  candidates: BlockCandidate[];
  pagination: PaginationHint;
  /** Anything that changes how the page must be handled: lazy images, framed content, a challenge. */
  notes: string[];
}

export interface BlockCandidate {
  selector: string;
  count: number;
  /** Fields found inside one block: a proposed selector and what it currently holds. */
  fields: FieldHint[];
}

export interface FieldHint {
  /** What this looks like: title, price, date, link, image, text. A guess, not a verdict. */
  role: string;
  selector: string;
  /** Set when the value lives in an attribute rather than in the text. */
  attr?: string;
  sample: string;
}

export interface PaginationHint {
  kind: 'link' | 'button' | 'scroll' | 'none';
  selector?: string;
  note?: string;
}

/**
 * What a door meant for a person says about itself. One list, used by the page sketch and by a run that
 * came back with nothing — those two look identical from the outside and mean opposite things.
 */
export const CHALLENGE_WORDS =
  /just a moment|checking your browser|verify you are human|confirm that you are human|if you are human|i'm not a robot|antibot|turnstile|cf-challenge|attention required|подтвердите, что вы человек|я не робот|проверка браузера/i;

export async function look(page: PageDriver): Promise<PageSketch> {
  return page.evaluate<PageSketch>(LOOK_SOURCE);
}

const LOOK_SOURCE = `
() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();

  // Tailwind class names carry colons and slashes — "sm:text-xl", "w-1/2" — and pasting them straight
  // into a selector produces something the browser refuses to parse, which killed whole sites here.
  // CSS.escape is what turns them back into something selectable.
  const esc = (name) => (window.CSS && CSS.escape ? CSS.escape(name) : name);
  const classesOf = (el) =>
    typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean) : [];
  const selectorOf = (el) => {
    const cls = classesOf(el);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(esc).join('.') : '');
  };
  const signature = selectorOf;

  // 1. Repeating blocks: same tag and classes, appearing often enough to be a list, carrying real text.
  const groups = new Map();
  for (const el of document.querySelectorAll('body *')) {
    const text = clean(el.textContent);
    if (text.length < 25 || text.length > 6000) continue; // a wordy card is still a card
    const key = signature(el);
    if (key.indexOf('.') === -1) continue;
    const group = groups.get(key) || { key, members: [] };
    group.members.push(el);
    groups.set(key, group);
  }

  // Frequency alone points at layout wrappers, not at rows. A row is recognised by structure:
  // its copies sit under one parent, they are about the same size, and each carries its own link.
  const median = (numbers) => {
    const sorted = numbers.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  };

  const scored = [];
  for (const group of groups.values()) {
    if (group.members.length < 4) continue;

    const parentKey = group.members[0].parentElement ? signature(group.members[0].parentElement) : '';
    const parentGroup = groups.get(parentKey);
    if (parentGroup && parentGroup.members.length === group.members.length) continue;

    const lengths = group.members.map((el) => clean(el.textContent).length);
    const mid = median(lengths);
    if (mid < 40) continue;

    const parents = new Map();
    for (const el of group.members) {
      const parent = el.parentElement;
      parents.set(parent, (parents.get(parent) || 0) + 1);
    }
    const sameParent = Math.max.apply(null, Array.from(parents.values())) / group.members.length;

    const spread = lengths.reduce((sum, n) => sum + Math.abs(n - mid), 0) / group.members.length / (mid || 1);
    const first = group.members[0];
    const hasLink = Boolean(first.querySelector('a[href]'));
    const hasHeading = Boolean(first.querySelector('h1, h2, h3, h4, h5, [class*=title]'));

    const score =
      Math.sqrt(group.members.length) *
      Math.sqrt(mid) *
      (0.4 + sameParent) *
      (hasLink ? 1.6 : 1) *
      (hasHeading ? 1.4 : 1) *
      (spread < 0.6 ? 1.4 : 1);

    scored.push({ group: group, score: score });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.map((entry) => entry.group);

  // 2. Inside one block of each candidate: what looks like a field, and what a selector for it is.
  const CURRENCY = /(?:[€£$¥]|\\bEUR\\b|\\bUSD\\b|\\bGBP\\b|\\bCHF\\b)\\s*\\d|\\d\\s*(?:[€£$¥])/;
  const DATE = /\\b\\d{1,2}[.\\/-]\\d{1,2}(?:[.\\/-]\\d{2,4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b/;

  const fieldsOf = (block) => {
    const fields = [];
    const seen = new Set();

    // Sites truncate visible text and keep the whole thing in an attribute. Taking the text would
    // quietly cost us the end of every title, and nobody notices a field that is merely shorter.
    const fullerAttr = (el, text) => {
      for (const name of ['title', 'alt', 'aria-label', 'content']) {
        const value = clean(el.getAttribute(name));
        if (value && value.length > text.length) return { name: name, value: value };
      }
      return null;
    };

    const propose = (el, role) => {
      const selector = selectorOf(el);
      if (seen.has(selector)) return;
      // Text must be unambiguous — two matches mean we do not know which one we are reading.
      // A link or an image is different: the extractor takes the first match, and the first link in
      // a card is the card's own link. Demanding uniqueness there just loses the most useful field.
      const matches = block.querySelectorAll(selector).length;
      if (matches !== 1 && role !== 'link' && role !== 'image') return;
      if (role === 'link') {
        const href = el.getAttribute('href') || '';
        if (!href) return;
        seen.add(selector);
        fields.push({ role: role, selector: selector, attr: 'href', sample: href.slice(0, 80) });
        return;
      }

      const text = clean(el.textContent);

      // The attribute must be read from whoever actually carries it: pointing a rule at the parent
      // of a titled link reads an attribute that is not there, and the field comes back empty.
      let holder = el;
      let fuller = fullerAttr(el, text);
      if (!fuller) {
        const inner = el.querySelector('a[title], [title], img[alt], [aria-label]');
        const innerAttr = inner ? fullerAttr(inner, text) : null;
        if (inner && innerAttr) {
          holder = inner;
          fuller = innerAttr;
        }
      }

      let holderSelector = selector;
      if (holder !== el) {
        const descriptor = selectorOf(holder);
        holderSelector = selector + ' ' + descriptor;
        if (!block.querySelector(holderSelector)) return;
      }

      const sample = fuller ? fuller.value : text;
      if (!sample) return;
      seen.add(selector);
      const hint = { role: role, selector: fuller ? holderSelector : selector, sample: sample.slice(0, 80) };
      if (fuller) hint.attr = fuller.name;
      fields.push(hint);
    };

    // A real heading beats a wrapper that merely has "title" in its class name.
    const heading = block.querySelector('h1, h2, h3, h4, h5, h6') || block.querySelector('[class*=title], [class*=Title]');
    if (heading) propose(heading, 'title');

    // The first anchor in a card is usually the logo or the image. The link that matters is the one
    // the heading sits in — that is the row's own address, and it is present in every card, not just
    // the ones with a badge.
    const link =
      (heading && heading.closest && heading.closest('a[href]') && block.contains(heading.closest('a[href]'))
        ? heading.closest('a[href]')
        : null) ||
      (heading ? heading.querySelector('a[href]') : null) ||
      block.querySelector('a[href]');
    if (link) propose(link, 'link');

    const image = block.querySelector('img[src], img[data-src]');
    if (image) propose(image, 'image');

    for (const el of block.querySelectorAll('*')) {
      if (el.children.length > 1) continue;
      const text = clean(el.textContent);
      if (!text || text.length > 60) continue;
      if (CURRENCY.test(text)) propose(el, 'price');
      else if (DATE.test(text)) propose(el, 'date');
      else if (fields.length < 8) propose(el, 'text');
    }

    return fields.slice(0, 8);
  };

  const sketchCandidates = candidates.slice(0, 4).map((group) => ({
    selector: group.key,
    count: group.members.length,
    fields: fieldsOf(group.members[0]),
  }));

  // 3. How the page continues.
  let pagination = { kind: 'none' };
  const NEXT_WORDS = /^(next|weiter|nächste|naechste|следующая|дальше|siguiente|suivant|›|»|>)$/i;
  const nextLink = Array.from(document.querySelectorAll('a[href]')).find((a) => {
    if (a.getAttribute('rel') === 'next') return true;
    const label = clean(a.textContent) + ' ' + (a.getAttribute('aria-label') || '');
    return NEXT_WORDS.test(clean(a.textContent)) || /\bnext page\b/i.test(label);
  });
  const arrowButton = Array.from(document.querySelectorAll('button'))
    .find((b) => /next|weiter|nächste|›|»/i.test(clean(b.textContent) + ' ' + (b.getAttribute('aria-label') || ''))
              || b.querySelector('[class*=arrowright], [class*=arrow-right], [class*=chevron-right]'));

  if (nextLink) {
    // The anchor itself rarely has a usable class; the control around it usually does.
    const parent = nextLink.parentElement;
    const parentCls = parent ? (classesOf(parent)[0] ? esc(classesOf(parent)[0]) : '') : '';
    const ownCls = classesOf(nextLink)[0] ? esc(classesOf(nextLink)[0]) : '';
    // A proposed selector that does not actually select the control is worse than none: it sends the
    // walk after something that is not there. So every candidate is tried against the page first.
    const href = nextLink.getAttribute('href') || '';
    const candidates = [
      nextLink.getAttribute('rel') === 'next' ? 'a[rel=next]' : '',
      ownCls ? 'a.' + ownCls : '',
      parentCls ? parent.tagName.toLowerCase() + '.' + parentCls + ' a' : '',
      href ? 'a[href="' + href + '"]' : '',
    ].filter(Boolean);

    let selector = '';
    for (const candidate of candidates) {
      try {
        if (document.querySelector(candidate) === nextLink) { selector = candidate; break; }
      } catch (e) { /* an invalid selector is simply not a candidate */ }
    }
    if (!selector) selector = candidates[candidates.length - 1] || 'a';
    pagination = { kind: 'link', selector: selector, note: clean(nextLink.textContent).slice(0, 30) };
  } else if (arrowButton) {
    const inner = arrowButton.querySelector('[class*=arrowright], [class*=arrow-right], [class*=chevron-right]');
    const cls = inner && typeof inner.className === 'string' ? inner.className.trim().split(/\\s+/)[0] : '';
    pagination = {
      kind: 'button',
      selector: cls ? 'button:has(.' + cls + ')' : 'button',
      note: 'client-side control — the walk must watch the rows, not the browser',
    };
  } else if (document.body.scrollHeight > window.innerHeight * 3) {
    pagination = { kind: 'scroll', note: 'long page, no next control found — infinite scroll is likely' };
  }

  // 4. Notes that change how the page must be handled.
  const notes = [];
  const lazy = document.querySelectorAll('img[data-src], img[loading=lazy]').length;
  if (lazy > 3) notes.push(lazy + ' images load lazily — rows may need scrolling before they carry images');
  const overlay = document.querySelector('[class*=cookie], [id*=cookie], [class*=consent]');
  if (overlay) notes.push('a consent overlay is present — a site rule should clear it before the walk');
  if (document.querySelectorAll('iframe').length > 0) notes.push(document.querySelectorAll('iframe').length + ' iframe(s) on the page');
  // A challenge page keeps its words in the title and in an iframe, so the body can look innocent.
  // Saying so at once matters: otherwise a model spends its whole budget interrogating an empty page.
  const challengeText = clean(document.title) + ' ' + clean(document.body.innerText).slice(0, 400);
  if (/just a moment|checking your browser|verify you are human|confirm that you are human|if you are human|i'm not a robot|antibot|turnstile|cf-challenge|attention required|подтвердите, что вы человек|я не робот|проверка браузера/i.test(challengeText)
      || document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], #challenge-form, #cf-challenge-running')) {
    notes.push('CHALLENGE PAGE — this is anti-bot protection, not the list. Nothing here can be scraped until it is passed.');
  }

  return {
    url: location.href,
    title: clean(document.title).slice(0, 120),
    candidates: sketchCandidates,
    pagination: pagination,
    notes: notes,
  };
}
`;
