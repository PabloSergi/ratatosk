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

## `dedupe`

```json
{ "dedupe": false }
```

Whether rows collected twice in the same walk are handed over once. Absent means yes, which is what a
list wants: a pager shifts under you while the walk is going and page two opens with what was last on
page one, and a pinned posting sits on every page.

Turn it off where identical rows are genuinely different things — a price tick, a sensor reading, the
same line meaning something new every time it appears. How many were dropped is reported in the run's
evidence, so a walk that keeps returning the same rows is visible rather than quietly shorter.

This is about one run. Whether the same posting is handed over again on the NEXT run is
[`remember`](#remember), and the two are independent.

## `remember`

```json
{ "remember": { "mode": "new", "by": "link", "days": 30 } }
```

Off unless you ask for it. A scraper without `remember` hands over everything it finds, every run —
which is right for anyone who wants the whole picture each time, or who is counting how often something
reappears. Turn it on and a row already handed over is not handed over again; what comes back is what
is new.

- `mode` — `new` returns only what has not been seen, which is the point of remembering. `all` returns
  everything and marks the repeats with `seenBefore` and `timesSeen`.
- `days` — how long a row is remembered after it was last seen. Default 30. A posting that vanished for
  two months and came back is news again.
- `by` — which column identifies a row. Leave it out and the scraper decides, which is almost always
  what you want.

### What identifies a row

Left to itself, a **page walk** is identified by its link: a job board gives a posting an address and
keeps it, so the address is the honest key. Where there is no link, the beginning of the row's text is
fingerprinted instead — the beginning, because a bump ("UP", "still open") is appended, and what
somebody wrote first is what identifies what they wrote.

A **channel** is the other way round. A message's link and its number address the *message*, not what
the message says: the same advert pushed out again tomorrow arrives as a new message with a new number,
and a memory keyed on that lets a daily reposter through daily. So a Telegram scraper identifies a post
by its text and by nothing else about it.

If that is wrong for your channel — you are watching for *events* and the same words twice mean twice —
name the column yourself:

```json
{ "remember": { "mode": "new", "by": "link" } }
```

which is per-message identity, said out loud. `by` is obeyed everywhere and overrules all of the above.

## A quiet day

A scraper that remembers spends most of its life finding rows it has already handed over. That run
comes back with nothing, and it is not a failure: the source answered, the rows were collected, and the
memory did its job. Such a run is marked quiet — the card says **nothing new** in green, the history
counts it as a working run, and the bot does not wake anybody about it.

An empty run that is *not* quiet is a different thing and still worth looking at: the page rendered and
had nothing on it, or the rule kept none of what came. Those two are told apart by where the emptiness
came from, and never by the row count alone.
