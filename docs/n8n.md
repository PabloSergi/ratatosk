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
collects: `POST /api/results` for that scraper says what the last runs brought back and when, newest
first, and `POST /api/results/get` with one of those timestamps hands over the rows. Use this when the
scraper is heavy or awkward — a browser held open for a minute is a long HTTP call to keep waiting on,
and a schedule that lives with the scraper is a schedule you can see from the card.

Either way the memory does the deduplicating: a scraper that remembers hands back only what it has not
handed over before, so the receiving end does not need a "have I seen this" table of its own.

## Two things worth knowing

**A run is not free.** It starts a browser, walks pages, and — if the scraper goes into rows — loads a
page per row. Schedule accordingly: hourly for a small list, nightly for a deep one.

**One scraper at a time per account.** Work inside an account is serialised, so ten scheduled runs firing
at once queue rather than starting ten browsers. Different accounts run side by side, and a scraper
already running is never started a second time — the lock is held for the length of the run.
