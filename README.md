# Ratatosk

[![test](https://github.com/PabloSergi/ratatosk/actions/workflows/test.yml/badge.svg)](https://github.com/PabloSergi/ratatosk/actions/workflows/test.yml)

A model builds the scraper once. After that it runs without a model — no tokens, no network to anyone
but the site, no surprises. When the site changes and the scraper breaks, the model is woken up to fix
it, shows you what it changed, and goes back to sleep.

That is the whole idea. Everything below is a consequence of it.

```
build   a model reads the page and writes a scenario: selectors, pagination, field map — plain JSON
run     the scenario runs on its own, deterministic and free
repair  zero rows or a changed page wakes the model: it rebuilds, proves the result, and shows the diff
```

## Quick start

```bash
npm install && npm run build && npx patchright install chromium

npm run look  -- "https://books.toscrape.com/catalogue/page-1.html"   # what a model would be shown
npm run draft -- "https://books.toscrape.com/catalogue/page-1.html"   # a proven scenario, no model
npm run run   -- examples/books.json                                  # run a finished scenario
npm test                                                              # 159 tests, no network
```

`draft` needs no API key: for an ordinary list it finds the rows itself. A key is only needed for pages
where that fails, and for the parts described under **Rules** below.

For the web view — accounts, scrapers, proxies, run history — see [docs/deploy.md](docs/deploy.md).

## What a scraper is

A file. Here is the whole of one:

```json
{
  "name": "books",
  "version": 1,
  "url": "https://books.toscrape.com/catalogue/page-1.html",
  "wait": { "selector": "article.product_pod", "minCount": 5, "timeoutMs": 15000 },
  "list": {
    "rows": "article.product_pod",
    "fields": {
      "title": { "type": "attr",  "selector": "h3 a", "attr": "title" },
      "price": { "type": "text",  "selector": ".price_color" },
      "link":  { "type": "attr",  "selector": "h3 a", "attr": "href" }
    }
  },
  "pagination": { "type": "link", "selector": "li.next a", "maxPages": 3 }
}
```

That is `examples/books.json`, copied out of the file the tests run.

Readable, editable by hand, diffable in review. Nothing about it is a black box, and a scraper you did not
like is a file you can change.

## What it handles

**Pagination**, six kinds: a next link, a button, infinite scroll, a cursor parameter, numbered pages,
and none at all. A walk that stops moving is detected by fingerprinting each page, so a "next" that
quietly returns the same rows ends the run instead of looping forever.

**Detail pages.** Lists are usually summaries — the pay is inside the card. A scraper can walk into each
row's link and bring fields back out, bounded by a row limit so a hundred-row page cannot become a
hundred page loads by accident.

**Rules**, when a page is not a list at all. A channel is a stream of whatever people write: postings,
CVs, memes, "up". Describe what you want in your own words and a model writes the rule — patterns that
keep, patterns that drop, fields read out of free text. The platform then measures that rule against
real messages before accepting it: a rule that keeps everything has decided nothing, a rule whose drops
eat its own finds is a leak, and a rule that keeps the wrong things is caught by reading its output back
to the model. At run time it is regular expressions over text — no model, no per-message cost.

**Memory.** The same posting gets reposted for weeks. A scraper can remember what it has already handed
over — by link, or by a fingerprint of the text that survives a "⬆️ up" appended to the end — and return
only what is new. It also forgets: something that disappeared for a month and came back is news again.

**Proxies**, per account and per scraper, HTTP or SOCKS5 with authentication. Chromium cannot do SOCKS5
with a username and password, so the platform runs a small local bridge and hands the browser something
it can use.

**Doors it will not open.** Some sites answer a datacentre IP with a challenge. Ratatosk does not solve
CAPTCHAs and will not: it opens the page in a browser **you** drive from your own screen, and once you
are through, the cookies stay with that scraper. See [docs/takeover.md](docs/takeover.md).

**Telegram.** Public channels are ordinary pages (`t.me/s/<channel>`). Groups have no page at all, so
they are read through a real client with your own account — the session lives on your machine and is
deletable from the same screen. See [docs/telegram.md](docs/telegram.md).

## Self-repair

A run that comes back `empty` or `broken` is a job, not a dead end. Repair looks at the page again, keeps
every field that still works, replaces the ones that died, re-probes pagination if the control is gone,
and proves the result by running it. What changed is shown, never applied behind your back:

```
rows: "div.announcement-card" → "div.announcement-wrapper"
field "title": h4.old-title → h5.title
repaired — 120 rows where there were 0
```

Rules rot too, and differently: nothing errors, people simply start writing about the same thing in new
words. A rule is measured against material collected now — coverage, collisions, and whether what it kept
is still what was asked for — and rewritten if it has drifted.

## Interfaces

**The web view** — accounts, scrapers, runs, proxies, keys. Bound to localhost; reach it over a tunnel or a
tailnet, never as a public address.

**MCP** ([docs/mcp.md](docs/mcp.md)) — two separate surfaces: building scrapers (`open → look → try →
paginate_probe → save`) and consuming data (`scrapers`, `fetch`). The consuming side never mentions a
selector.

**HTTP**, for anything that already schedules things. There is deliberately no scheduler inside: a scraper
is one call, and cron, n8n or your own code already know how to retry and deliver.
See [docs/n8n.md](docs/n8n.md).

```bash
curl -H "authorization: Bearer rtk_…" -H 'content-type: application/json' \
     -d '{"name":"city-jobs","maxPages":3}' http://127.0.0.1:5544/api/run
```

## How it is built

No frameworks on either end, and that is a choice rather than an omission. The engine, the MCP server and
the web service are plain TypeScript on `node:http`; the front-end is TypeScript and the DOM, bundled by
esbuild into a few kilobytes of static files. The front imports the engine's own types — the answer to
`/api/run` is declared as `RunResult`, the type `runScenario` returns — so renaming a field in the engine
breaks the build instead of breaking the screen.

```
src/     engine, agent, rules, memory, MCP server, telegram, accounts, web service
web/     the operator view: index.html, styles.css, api.ts, render.ts, app.ts
test/    159 tests over the sources — engine, API, markup, and the wiring between them
e2e/     the whole product in a real browser, against a fixture site
docs/    scenario format, build loop, MCP, telegram, accounts, deploy, n8n, takeover
```

Tests and logging are part of the product, not an afterthought:
[CONTRIBUTING.md](CONTRIBUTING.md) says what each layer is for.

## Principles

- Zero rows is never "success" — it is its own status, visible, with a reason. Neither is a required
  column that came back empty in every row.
- The extractor travels with every call and leaves no global behind, so "the helper code never arrived"
  cannot happen.
- One masking layer only: a stealth browser or a fingerprint injector, never both.
- No hardcoded User-Agent — take it from the browser.
- Wait for the real DOM before analysing the page.
- Site rules are a first-class mechanism, not a patch on top — and they clear a consent overlay by
  removing it, never by accepting it on someone's behalf.
- A page that turns is not a page that turned: on client-rendered sites the walk watches the rows, not
  the browser.
- Nothing here defeats a CAPTCHA, a bot check, or a login you do not have.

## License

Source-available under the [Sustainable Use License](LICENSE.md) (fair-code), the same model n8n uses:
free for your own internal business, personal and non-commercial use; offering it to others as a paid
service requires a commercial license. Files marked `.ee` are Enterprise-licensed.
