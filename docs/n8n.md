# Ratatosk from n8n

Ratatosk builds scrapers and runs them. It does not schedule, retry, split, join, or deliver anywhere —
n8n already does all of that better than a scraping tool ever will. So the seam between them is one
HTTP call, and this is what it looks like.

## A key, not your login

Your own token expires in a month. An automation set up today should not stop working in a month, so a
machine gets its own credential: **Keys → Make a key**. It is shown once, named so
you know a year later what it was for, and revoked on its own without disturbing the others.

The key goes in one header:

    Authorization: Bearer rtk_…

Everything below works the same with a key or with a signed-in token.

## Run a scraper on a schedule

**Schedule Trigger** → **HTTP Request**:

| field | value |
| --- | --- |
| Method | `POST` |
| URL | `https://your-ratatosk/api/run` |
| Authentication | Generic → Header Auth (`Authorization` = `Bearer rtk_…`) |
| Send Body | on, JSON: `{ "name": "city-jobs", "maxPages": 3 }` |

The answer is the run itself:

```json
{
  "status": "ok",
  "rows": [{ "title": "…", "company": "…", "city": "…", "pay": "$2000-$3000/mo" }],
  "pagesVisited": 3,
  "reason": null
}
```

Three statuses, and the difference is the point of this whole project:

- `ok` — rows came back.
- `empty` — the page rendered and had nothing on it. The site may genuinely be empty today.
- `broken` — the scraper no longer fits the page. `reason` says what rotted.

So the node after it is an **IF** on `{{ $json.status }}`, and `broken` goes to whatever wakes a human:
Telegram, email, an issue. That is the alert you would otherwise have written yourself, and it is the
one that matters — a scraper returning nothing quietly is the failure this product exists to prevent.

To fan the rows out one by one, follow with **Split Out** on `rows`.

## The rest of the doors

| what | where | body |
| --- | --- | --- |
| list the scrapers | `POST /api/robots` | — |
| run one | `POST /api/run` | `{ "name": "…", "maxPages": 3 }` |
| repair one | `POST /api/repair` | `{ "name": "…" }` |
| how they are all doing | `POST /api/history` | `{ "limit": 60 }` |
| build a new one | `POST /api/agent` | `{ "url": "…", "want": "…", "proxy": "…" }` |
| what a scraper's last runs brought back | `POST /api/results` | `{ "name": "…" }` |
| the rows of one of them | `POST /api/results/get` | `{ "name": "…", "at": "2026-09-05T03:37:46.595Z" }` |
| everything all of them brought back since a moment | `POST /api/harvest` | `{ "since": "2026-09-05T06:00:00.000Z" }` |
| what runs by itself, and when next | `POST /api/schedules` | — |
| set that | `POST /api/schedule/set` | `{ "name": "…", "everyMinutes": 60 }` |

`/api/history` is the one to hang a morning digest on: it answers with `standing`, a line per scraper
saying how it is now and how many runs in a row it has been that way. One bad run is noise; five are a
verdict.

## Which of you drives

Two arrangements, and the difference is who owns the clock.

**n8n drives.** Schedule Trigger → HTTP Request to `/api/run` → your nodes. The run happens inside the
call, so the rows arrive in the same answer and n8n has them without asking twice. Use this when the
delivery is the point and the timing belongs with the rest of your workflow.

**Ratatosk drives.** Set an interval on the scraper's card and let its own worker run it. n8n then only
collects. Use this when the scraper is heavy or awkward — a browser held open for a minute is a long
HTTP call to keep waiting on, and a schedule that lives with the scraper is a schedule you can see from
the card.

Collecting is one call, whatever the scraper:

    POST /api/harvest    { "since": "2026-09-05T06:00:00.000Z" }

and everything every scraper of yours brought back after that moment comes out flat:

```json
{
  "since": "2026-09-05T06:00:00.000Z",
  "until": "2026-09-06T06:00:00.000Z",
  "rows": [
    { "scraper": "city-jobs", "kind": "web", "at": "2026-09-06T03:12:44.001Z", "fields": { "title": "…", "link": "…" } },
    { "scraper": "tg-hiring", "kind": "telegram", "at": "2026-09-06T03:41:02.884Z", "fields": { "text": "…", "link": "…" } }
  ]
}
```

`since` is exclusive, so passing back the previous answer's `until` asks for exactly what is new. Leave
it out and it looks back a day and an hour — a scraper on a daily schedule and a collection on a daily
schedule drift against each other, and an hour of overlap costs a few rows the far side already has
rather than a day of postings nobody ever sent.

`kind` is there because it decides how the far side must read the row: `web` is already fields, and
`telegram` is a paragraph somebody typed, which usually wants a model between it and a database.

The per-scraper doors are still there when a person, not a machine, is the one asking: `POST /api/results`
says what one scraper's last runs brought back and when, and `POST /api/results/get` with one of those
timestamps hands over that run's rows.

Either way the memory does the deduplicating: a scraper that remembers hands back only what it has not
handed over before, so the receiving end does not need a "have I seen this" table of its own.

## Two things worth knowing

**A run is not free.** It starts a browser, walks pages, and — if the scraper goes into rows — loads a
page per row. Schedule accordingly: hourly for a small list, nightly for a deep one.

**One scraper at a time per account.** Work inside an account is serialised, so ten scheduled runs firing
at once queue rather than starting ten browsers. Different accounts run side by side, and a scraper
already running is never started a second time — the lock is held for the length of the run.
