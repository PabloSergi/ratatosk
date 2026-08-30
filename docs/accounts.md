# Accounts

The platform can be run for one person or handed to many. The difference is only that with accounts on,
everything a person makes belongs to them.

## What a person gets

- **their own scrapers** — `robots/u/<user id>/`, invisible to everyone else
- **their own Telegram session** — `secrets/telegram/<user id>.json`, connected and disconnected by them
- **their own token** — signed with a key generated once and kept in `secrets/jwt.key`

The first account created adopts any scrapers that already existed before there were accounts, so turning
this on does not orphan the work of whoever was already running it.

## Signing up

Registration is open and there is no email confirmation. That is a deliberate choice for now, not an
oversight — and it means **anyone who can reach the address can create an account**. Before putting this
on a public URL:

- terminate TLS in front of it (the token travels in a header; without TLS it travels in the clear)
- rate-limit `/api/auth/*` at the proxy — nothing here slows down a password-guessing script
- decide whether you want open registration at all, or invite codes

## What is stored, and how

Passwords are never stored: only a scrypt hash with a per-user salt, compared in constant time. A wrong
password and an unknown address give the same answer and take the same time, so the login form does not
tell a stranger which addresses are registered. Files holding secrets are written with owner-only
permissions.

## The model key

Building scrapers costs money — someone's money — so each account brings its own key rather than
spending the server owner's. The Model section walks through it: create a key at openrouter.ai/keys,
put a few dollars on it, paste it. The key is checked against the provider before it is stored (and the
answer includes what is left on it), kept in `secrets/settings/<user id>.json` with owner-only
permissions, and shown afterwards only as its last four characters. **Delete key** removes it.

The model itself is chosen from the same section — only models that support tool calls are offered,
cheapest first, with the price per million tokens next to each. A build costs fractions of a cent; a
run costs nothing at all, because no model is involved once a scraper exists.

If the server has `OPENROUTER_API_KEY` in its environment, that is used when an account has no key of
its own — convenient for a single-user install, irrelevant once there are several.

## Proxies

Sites block by address, not by selector: a page that answers "here is your IP and the time" is not
going to be talked round, and no amount of selector work changes that. So an account keeps its own
proxies — `http://user:pass@host:port` or `socks5://host:port` — in `secrets/proxies/<user id>.json`,
owner-only like every other secret. The list shows the host and a hint of the user; the password is
never sent to the browser side.

A proxy is checked the only honest way: the browser goes out through it and reports which address the
world saw. A scraper built through a proxy keeps that proxy, because the address is part of how it works,
and each address gets its own browser profile — switching mid-profile would mix two identities in one
cookie jar, which is the thing a proxy exists to avoid.

Telegram scrapers do not use these: they talk to Telegram through its own client, not a browser.

## Browsers

Every account gets its own browser and its own profile in `profiles/<user id>`, so cookies and storage
picked up by one account's scraper are invisible to another's. A headed Chromium is expensive, so only the
few most recently used stay open — `RATATOSK_MAX_BROWSERS`, three by default — and the rest are closed
and started again on demand. Work inside one account is serialised; different accounts run in parallel.

## MCP with accounts

The MCP server is a process a client starts, so it has no login of its own. It is told which account it
speaks for by a token — the same token the web view issues, shown under **token for MCP**:

```json
{
  "mcpServers": {
    "ratatosk": {
      "command": "node",
      "args": ["/opt/ratatosk/dist/mcp/server.js"],
      "env": { "RATATOSK_TOKEN": "<the token>" }
    }
  }
}
```

On an installation with no accounts at all the token is unnecessary and everything lives in the plain
`robots/` directory — the single-user case stays simple. On an installation that has accounts, a
missing token is refused rather than silently showing somebody else's scrapers.

## Configuration

| Variable | Meaning |
|---|---|
| `RATATOSK_USERS` | where accounts live (default `secrets/users.json`) |
| `RATATOSK_JWT_SECRET` / `RATATOSK_JWT_SECRET_FILE` | signing key, or where to keep the generated one |
| `RATATOSK_TOKEN_TTL` | token lifetime in seconds (default 30 days) |
| `RATATOSK_ROBOTS` | root of the scrapers directory |
