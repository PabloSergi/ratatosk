# The scenario

A scenario is what the model produces once, at build time. Every run after that reads this file and
nothing else — no model, no prompt, no network call to an LLM. It is plain JSON so a human can open it,
see why a run went wrong, and fix a selector by hand.

```json
{
  "name": "dancersjobs",
  "version": 1,
  "url": "https://example.com/jobs",
  "wait": {
    "selector": ".job-card",
    "minCount": 3,
    "timeoutMs": 15000,
    "settleMs": 2000
  },
  "list": {
    "rows": ".job-card",
    "fields": {
      "title":  { "type": "text" , "selector": "h2" },
      "url":    { "type": "attr" , "selector": "a", "attr": "href", "absolute": true },
      "salary": { "type": "text" , "selector": ".pay", "optional": true }
    }
  },
  "pagination": { "type": "link", "next": "a[rel=next]", "maxPages": 20 },
  "expect": { "minRowsPerPage": 1 }
}
```

## wait

Never analyse a page before it renders — a challenge page or an empty skeleton looks exactly like a site
with no data. `minCount` is what separates "the content arrived" from "one stray placeholder"; `settleMs`
gives lazy rendering time to finish after the threshold is met.

## list

`rows` selects the repeating block. Fields are read inside a block, so their selectors stay short and
survive layout changes better than absolute paths. A field with no `selector` reads the block itself.

Field types: `text` (whitespace collapsed), `attr` (with `absolute: true` to resolve a URL against the
page), `html` (raw inner HTML). A field marked `optional` may be missing without counting as damage.

A block where every field came back empty is dropped, and the number of blocks seen is reported — that
gap between "blocks matched" and "rows produced" is how a run tells a rotted field selector from an
empty site.

## pagination

- `{"type": "none"}` — single page, and the engine visits exactly one
- `{"type": "link", "next": "...", "maxPages": N}` — follow a link
- `{"type": "button", "next": "...", "maxPages": N}` — click a control that loads the next page
- `{"type": "scroll", "maxRounds": N, "settleMs": M}` — infinite scroll; each round re-reads the whole
  document, because that is what infinite scroll actually does

Pagination always has a budget. A scenario cannot walk a site forever.

## expect

`minRowsPerPage` is what a healthy page looks like. Falling below it stops the walk and shows up in the
run status — silence is never treated as success.

## Run outcome

A run ends in one of three states, and two of them carry a reason:

| Status | Meaning |
|---|---|
| `ok` | rows came back, at least as many as expected |
| `empty` | the page rendered but the row selector matched nothing — the site may genuinely be empty |
| `broken` | nothing rendered, the extractor failed to land, or every field came back empty |

`empty` and `broken` are both visible, both carry evidence (URL, blocks seen, which fields went missing),
and both are what later wakes the model up to rebuild the scenario.
