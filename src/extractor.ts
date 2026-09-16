/**
 * Source of the code that runs INSIDE the page. It is a string on purpose: it is sent to the browser,
 * never imported, and it must not close over anything from the Node side.
 *
 * It travels with every call and leaves nothing behind — no global, no script tag, no state that a
 * later call has to hope is still there. That is what makes "the helper code did not arrive" an
 * impossible failure rather than one we have to guard against: there is no earlier step to lose.
 *
 * (Learned the hard way: patchright evaluates in an isolated world while an injected <script> runs in
 * the main one, so a global set by injection is invisible to the very code meant to call it.)
 */
export const EXTRACTOR_SOURCE = `
(list) => {
  const one = (node, rule) => {
    if (rule.type === 'attr') {
      const raw = node.getAttribute(rule.attr);
      if (raw === null) return null;
      if (!rule.absolute) return raw;
      try { return new URL(raw, document.baseURI).href; } catch (e) { return raw; }
    }
    if (rule.type === 'html') return node.innerHTML.trim();
    return (node.textContent || '').replace(/\\s+/g, ' ').trim();
  };

  const pick = (root, rule) => {
    // Every match rather than the first: a gallery is one field with many pictures in it, and picking
    // the first one silently turns a posting with twelve photographs into a posting with one.
    if (rule.all) {
      if (!rule.selector) return one(root, rule);
      const found = [];
      for (const node of Array.from(root.querySelectorAll(rule.selector))) {
        const value = one(node, rule);
        // The same picture is often drawn three times over — a carousel keeps the neighbours of the
        // frame you are looking at. Three copies of one address is not three photographs.
        if (value && found.indexOf(value) === -1) found.push(value);
      }
      return found.length ? found.join('\\n') : null;
    }
    const node = rule.selector ? root.querySelector(rule.selector) : root;
    if (!node) return null;
    return one(node, rule);
  };

  let blocks;
  try {
    blocks = Array.from(document.querySelectorAll(list.rows));
  } catch (e) {
    // An invalid selector must come back as an answer, not as an exception that kills the whole run.
    return { rows: [], blocksSeen: 0, missing: {}, error: 'not a valid CSS selector: ' + list.rows };
  }
  const rows = [];
  const missing = {};

  for (const block of blocks) {
    const row = {};
    let usable = false;
    for (const entry of Object.entries(list.fields)) {
      const field = entry[0];
      const rule = entry[1];
      const value = pick(block, rule);
      if (value === null || value === '') {
        if (!rule.optional) missing[field] = (missing[field] || 0) + 1;
        row[field] = null;
      } else {
        row[field] = value;
        usable = true;
      }
    }
    if (usable) rows.push(row);
  }

  return { rows: rows, blocksSeen: blocks.length, missing: missing };
}
`;

/** What comes back from the page. blocksSeen vs rows.length is how we tell "no data" from "wrong selector". */
export interface ExtractResult {
  rows: Array<Record<string, string | null>>;
  blocksSeen: number;
  missing: Record<string, number>;
  /** Set when the page could not even use the selector — invalid CSS, most often. */
  error?: string;
}

export class ExtractionError extends Error {}

/** Nothing is trusted across the browser boundary: a malformed answer is a broken run, not a crash. */
export function asExtractResult(value: unknown, url: string): ExtractResult {
  const result = value as ExtractResult | undefined;
  if (!result || !Array.isArray(result.rows) || typeof result.blocksSeen !== 'number') {
    throw new ExtractionError(`extractor returned nothing usable on ${url} — the page rejected it or the browser context is not ours`);
  }
  return result;
}
