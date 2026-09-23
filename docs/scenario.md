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

`all: true` takes every match instead of the first, joined by newlines — a gallery of photographs, a
row of tags. Without it a posting with twelve pictures quietly becomes a posting with one.

A block where every field came back empty is dropped, and the number of blocks seen is reported — that
gap between "blocks matched" and "rows produced" is how a run tells a rotted field selector from an
empty site.

## pagination

- `{"type": "none"}` — single page, and the engine visits exactly one
- `{"type": "link", "next": "...", "maxPages": N}` — follow a link
- `{"type": "button", "next": "...", "maxPages": N}` — click a control that loads the next page
- `{"type": "scroll", "maxRounds": N, "settleMs": M}` — infinite scroll. A round moves one screen down
  whatever is actually scrolling: on most feeds the page does not scroll at all, the rows sit in a box
  with its own scrollbar. Rows are kept as each round sees them, because a long feed recycles its nodes
  — what scrolled off is no longer in the document, and a walk that read the document at the end would
  come back with the last screen and call it the site. Repeats across rounds are collapsed whether or
  not `dedupe` is on; there is no other way to read the same list twice
- `{"type": "param", "param": "before", "from": "id", "maxPages": N}` — a cursor taken from the last
  row on the page, which is how message archives and many APIs-behind-HTML work
- `{"type": "number", ..., "maxPages": N}` — a plain numbered pager, where the number is the only
  durable thing about it: the class marking the current page is generated at build time and changes
  with the site's next deploy

A numbered pager has to say **where the number goes**, and there are two places:

```json
{ "type": "number", "param": "page", "maxPages": 20 }   // ?page=2
{ "type": "number", "path": "/p{n}", "maxPages": 20 }   // /p2, /page/2, /trang-2
```

`{n}` is where the number lands. Page one is the address as written; the numbering starts at `start`
(2 by default) and moves by `step`.

Getting this wrong is invisible, which is why it is refused rather than guessed: a site that paginates
by path answers the query form with the **first page again**, every time. The walk then stops after one
page and reports a healthy run, because one page of rows did come back.

Pagination always has a budget. A scenario cannot walk a site forever.

## pace

```json
{ "pace": 3000 }
```

How long to wait between page loads, in milliseconds. Absent means the engine's own small pause —
enough for a quiet site, not enough for a guarded one.

A walk goes as fast as the machine allows, which is faster than any person reads, and that is exactly
what a source watching its traffic notices. The arithmetic is worth doing once: twenty pages at three
seconds is a minute longer than at full speed, and being noticed costs the source entirely.

Applies to every kind of pagination, and to the walk into rows.

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

### What is not opened twice

A scenario with both `detail` and `remember` does not open a page for a row it has already handed over.
The first pass pays for every row; the ones after it pay only for what is new, which on a list read
every few hours is the few at the top. The run says how many it spared, so a pass that suddenly opens
everything is visible rather than merely slow.

The identity used for that decision is the same one the memory uses afterwards, columns cut out by
`sift` included — otherwise the walk and the memory would disagree about what a row is, and the answer
would be to open everything or nothing.

`mode: "all"` turns this off by itself: a run that hands over repeats has to hand them over whole.

## `catalogue`

```json
{ "catalogue": "id" }
```

Off unless you name a column. What it names is the one that identifies a row on the source — an id, a
permalink, a listing number. Something that means the same thing tomorrow.

With it, the scraper keeps a second thing beside its runs: **what the source holds**, as opposed to
what a run brought back. Every row a pass saw goes in, whether or not it was handed on, with the day
it was first seen and the day it was last seen.

The difference matters as soon as [`remember`](#remember) is on. A scraper that remembers hands over
increments — fifty rows this hour, of a source that has thirty thousand. The journal of runs is
therefore a journal of increments, and adding those runs back together gives the source only until the
oldest of them ages out. After that a source of thirty thousand quietly reads as a source of fifty,
with no error anywhere, and whatever tidies up behind it deletes the rest.

Two things then become answerable exactly, and neither opens a page:

    POST /api/catalogue   { "name": "…", "limit": 1000, "after": "…" }
    POST /api/vanished    { "name": "…" }

`/api/catalogue` is the source, paged by id — hand back the `next` from one answer to get the following
page. `/api/vanished` is what the last pass did not see: let, taken down, sold. Not a guess from the
absence of rows in a run, which is what an increment always looks like.

Leave it out where rows have no lasting identity — a source whose rows are known only by a fingerprint
of their own text cannot be catalogued, and a catalogue of those would be new every time it is read.

## `alive`

```json
{ "alive": { "url": "https://example.com/item/{id}", "gone": "no longer available", "pace": 300 } }
```

How to ask whether one row is still there. Off unless you say it; needs [`catalogue`](#catalogue),
because it is the catalogue that is being revised.

`{id}` is where the catalogue's id goes. `gone` is a pattern matched against what comes back — what a
page says when it no longer holds the thing. `pace` is the wait between questions.

The revision is run separately from the walk, because it answers a different question on a different
clock: `node scripts/recheck.mjs <scraper>`. What answers for itself has its sighting refreshed; what
does not is left where it is, and falls behind the catalogue's boundary — which is what
[`/api/vanished`](#catalogue) reads.

**Why this exists.** On a list a pass walks through to the end, what the pass did not meet is gone, and
that is free. On a feed a pass reaches the first few hundred of thousands, so the same subtraction
measures our patience instead of the source: on a live catalogue, of the postings unseen for three
days every one checked was still up. A source read that way needs asking, not subtracting.

The question is asked from inside a page of the same site, in the scraper's own browser — that is what
carries the session, and a request made from anywhere else comes back as "sign in" for everything,
which reads as an empty source. A request costs under a second where opening the page costs five.

## A quiet day

A scraper that remembers spends most of its life finding rows it has already handed over. That run
comes back with nothing, and it is not a failure: the source answered, the rows were collected, and the
memory did its job. Such a run is marked quiet — the card says **nothing new** in green, the history
counts it as a working run, and the bot does not wake anybody about it.

An empty run that is *not* quiet is a different thing and still worth looking at: the page rendered and
had nothing on it, or the rule kept none of what came. Those two are told apart by where the emptiness
came from, and never by the row count alone.
