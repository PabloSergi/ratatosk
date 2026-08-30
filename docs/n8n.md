# Ratatosk from n8n

Ratatosk builds robots and runs them. It does not schedule, retry, split, join, or deliver anywhere —
n8n already does all of that better than a scraping tool ever will. So the seam between them is one
HTTP call, and this is what it looks like.

## A key, not your login

Your own token expires in a month. An automation set up today should not stop working in a month, so a
machine gets its own credential: **Runs → Keys for machines → Make a key**. It is shown once, named so
you know a year later what it was for, and revoked on its own without disturbing the others.

The key goes in one header:

    Authorization: Bearer rtk_…

Everything below works the same with a key or with a signed-in token.

## Run a robot on a schedule

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
  "rows": [{ "название": "…", "студия": "…", "город": "…", "зарплата": "50 000 — 500 000 ₽" }],
  "pagesVisited": 3,
  "reason": null
}
```

Three statuses, and the difference is the point of this whole project:

- `ok` — rows came back.
- `empty` — the page rendered and had nothing on it. The site may genuinely be empty today.
- `broken` — the robot no longer fits the page. `reason` says what rotted.

So the node after it is an **IF** on `{{ $json.status }}`, and `broken` goes to whatever wakes a human:
Telegram, email, an issue. That is the alert you would otherwise have written yourself, and it is the
one that matters — a robot returning nothing quietly is the failure this product exists to prevent.

To fan the rows out one by one, follow with **Split Out** on `rows`.

## The rest of the doors

| what | where | body |
| --- | --- | --- |
| list the robots | `POST /api/robots` | — |
| run one | `POST /api/run` | `{ "name": "…", "maxPages": 3 }` |
| repair one | `POST /api/repair` | `{ "name": "…" }` |
| how they are all doing | `POST /api/history` | `{ "limit": 60 }` |
| build a new one | `POST /api/agent` | `{ "url": "…", "want": "…", "proxy": "…" }` |

`/api/history` is the one to hang a morning digest on: it answers with `standing`, a line per robot
saying how it is now and how many runs in a row it has been that way. One bad run is noise; five are a
verdict.

## Two things worth knowing

**A run is not free.** It starts a browser, walks pages, and — if the robot goes into rows — loads a
page per row. Schedule accordingly: hourly for a small list, nightly for a deep one.

**One robot at a time per account.** Work inside an account is serialised, so ten scheduled runs firing
at once queue rather than starting ten browsers. Different accounts run side by side.
