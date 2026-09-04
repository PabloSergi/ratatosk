# Telegram

Two kinds of source live behind the same word, and they need different things.

## Public channels — nothing to set up

A public channel has a web preview at `t.me/s/<channel>`, which is an ordinary page with an ordinary
list on it. Build a scraper for it the way you would for any site: paste the URL, say what you want.

History is walked by cursor rather than by a "next" button — `?before=<id>` — and the shipped rule in
`rules/telegram.json` tells the engine so. It is still proven by use: if the walk does not move, the
scraper is honest about covering one page.

## Groups — your own account

Groups have no web page at all. Reading one means being a member of it, which means a real Telegram
client with a real account — and that account is yours, not the platform's.

The operator view walks through it as three lit steps, and every value stays on your machine:

1. **Get an api_id and an api_hash.** <https://my.telegram.org> → log in with your phone number →
   *API development tools*. Fill *App title* and *Short name* with anything and press *Create
   application*. The page then shows **App api_id** (a number) and **App api_hash** (32 characters).
2. **Type the code.** It arrives *inside Telegram*, from the account called "Telegram" — not by SMS
   unless no other device is signed in. If the account has two-step verification, its password goes in
   the second field; otherwise leave it empty.
3. **Make a scraper.** The form appears as soon as you are connected: channels and groups by username,
   how many recent messages to take, and an optional word filter.

The session is written to `secrets/telegram.json` with owner-only permissions, on the machine running
the platform. It is never sent anywhere, it is not in the repository, and **Disconnect account**
deletes it.

Nobody else — not the maintainers, not a hosted service, not a model — sees the code or the password.
That is the point of doing the login here rather than asking someone to do it for you.

## A Telegram scraper

```json
{
  "name": "tg-jobs",
  "version": 1,
  "source": "telegram",
  "channels": ["pythonjobs", "remote_work", "devhires"],
  "limit": 200,
  "contains": ["hiring", "vacancy"]
}
```

`limit` is how many recent messages to take from each channel; `contains` keeps only messages carrying
one of those words, and may be omitted. Rows come back as `channel`, `id`, `date`, `text`, `link` —
the same shape as any other scraper, so `fetch` and the run view treat them identically.

Repair does not apply: there are no selectors to rot. If a scraper returns nothing, either the account
lost access to the group or the filter is too tight, and the run says which.

## Being told when something breaks

A scraper that says when it breaks says it to whoever opens the screen. One on a schedule breaks at four
in the morning on a Tuesday and is found on Friday, by which point whatever reads its rows has been
quietly wrong for three days.

So a run can tell somebody, through a bot of your own — **Telegram → Being told when something breaks**:

1. `/newbot` to [@BotFather](https://t.me/BotFather); paste the token it gives you.
2. Write anything to your new bot once. A bot cannot start a conversation.
3. Paste your chat id, which [@userinfobot](https://t.me/userinfobot) will tell you.

Three decisions are built in, and all three are about not becoming noise:

- **One bad run is not a breakage.** A site hiccups, a proxy blinks, a page takes too long. Only a streak
  counts, and how long it has to be is yours to set — three runs by default.
- **One message per breakage, not per run.** A scraper running every half hour must not send forty eight
  messages about the same dead selector.
- **Recovery is worth exactly one message too**, or the only way to learn that something is fine again is
  to go and look.

The token is stored for your account alone, with owner-only permissions, and never leaves the server —
the screen shows its last four characters and nothing else. A test message is one press, because "it is
set up" and "it works" are different claims.

Nothing is sent by the platform on a timer: the telling happens when a run happens. A scraper nothing
runs will never report itself broken, because nothing has asked it to work.
