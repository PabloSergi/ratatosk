# Running it on a server

Everything here assumes Docker and a machine you can reach over SSH. Nothing is published to the
internet at any point: the web view can run scrapers and rewrite them, so it is a window onto a machine,
not a public service.

## Install

```bash
git clone https://github.com/PabloSergi/ratatosk.git && cd ratatosk
cp .env.example .env          # every value has a working default; you can start with it untouched
docker compose build          # a few minutes and ~1 GB: the browser is baked into the image
docker compose up -d web logs
```

The stack starts its own Postgres, in its own container with its own volume, and publishes no port for
it. An installation brings its database with it rather than expecting to find one — the difference
between "clone and run" and "clone, then set up a database something else on this machine is already
using". What a run brought back is kept there; everything else is still files next to the compose file.

Run it without Docker and `RATATOSK_DB` is simply unset, and runs are kept in files instead. Same code,
no database server to install first. That variable is the only thing that decides, because a service
that quietly writes somewhere other than where you think it does is a service you cannot back up.

Check it came up before opening anything:

```bash
docker compose run --rm web node dist/cli.js examples/books.json   # a real scrape, no model involved
docker compose ps
```

The image installs Chromium with its system libraries at build time, so nothing is discovered to be
missing on the first run.

## Getting to the view

It listens on **127.0.0.1:5544** — localhost of the *server*. Reach it with a tunnel from your own
machine:

```bash
ssh -f -N -L 5544:127.0.0.1:5544 you@your-server
open http://127.0.0.1:5544
```

Closing the tunnel closes the door. If the machine is on a tailnet, that is the better door — it
survives reboots, works from a phone, and gets a real certificate:

```bash
tailscale serve --bg --https 5544 http://127.0.0.1:5544
tailscale serve status                              # what is published
tailscale serve --https 5544 off                    # take it down
```

That is `serve`, not `funnel`: reachable inside your tailnet and nowhere else. Do not reach for
`funnel` here — registration is open by design, and a service that builds and runs browsers is not
something to leave facing strangers. If a public URL is genuinely wanted, it belongs behind a reverse
proxy **with authentication in front of it**.

## First five minutes in the view

1. **Register.** The first account is yours; registration is open and unconfirmed by design, which is
   safe exactly as long as the address is not public. See [accounts.md](accounts.md).
2. **Add a model connection.** Any OpenAI-compatible provider; the key is stored per account and never
   leaves the server whole. A separate cheap model can be set for what runs on every scrape.
3. **Add a proxy** if the sites you want block datacentre addresses — HTTP or SOCKS5, with or without
   a password.
4. **Build a scraper**: paste a URL, say what you want in your own words, press Build. What comes back is
   a scenario proven on a real page, not a promise.
5. **Run it.** Each scraper's card says how it has been doing; pressing its state line unfolds every
   run it has had, and the round arrow checks it without running it at all.

## Logs

Dozzle comes up with the stack on **127.0.0.1:5545** — same tunnel, live search across all containers.
Or read them straight:

```bash
docker compose logs -f web                                   # one JSON line per event
docker compose logs web | grep '"level":"error"'
```

Set `RATATOSK_LOG=debug` in `.env` and restart the container to get browser and live-view detail. Log
lines never contain keys, passwords or session strings — there is a test that asserts it.

## Updating

```bash
git pull
docker compose build web && docker compose up -d web
```

Scrapers, run history, accounts and browser profiles live in volumes and folders next to the compose
file, so they survive the rebuild. What is worth backing up is small and boring:

```bash
docker compose exec -T db pg_dump -U ratatosk ratatosk | gzip > ratatosk-db.sql.gz
tar czf ratatosk-backup.tgz robots/ history/ memory/ secrets/ .env
```

`secrets/` holds accounts, the token key and any Telegram session — treat that tarball the way you
would treat a password file.

## After a reboot

Containers come back on their own (`restart: unless-stopped`) **only if the Docker service itself
starts at boot**. On some installs it is disabled:

```bash
systemctl is-enabled docker || sudo systemctl enable --now docker docker.socket
```

A tunnel does not survive a reboot; a `tailscale serve` does.

## What the compose file is guarding against

- `mem_limit` **and** `memswap_limit` are both set. The swap limit is the important one: without it a
  runaway page drags the whole host into swap instead of the container dying alone.
- `shm_size: 1g`, because Chromium crashes on Docker's default 64 MB `/dev/shm`.
- The Docker socket that Dozzle reads is mounted **read-only**, and its port is on loopback.
- `robots/`, `history/`, `memory/` and `results/` are volumes: they are the product's data, not a cache.

## As an MCP server

The server speaks stdio, so the client starts the process:

```json
{
  "mcpServers": {
    "ratatosk": {
      "command": "docker",
      "args": ["compose", "-f", "/opt/ratatosk/docker-compose.yml", "run", "--rm", "-T", "mcp"]
    }
  }
}
```

Running it directly on the host works too and starts faster:

```bash
npm install && npm run build && npx patchright install chromium
node dist/mcp/server.js
```

## On a schedule

There is no scheduler inside the platform on purpose — a scraper is one command, and the host already has
cron:

```cron
*/30 * * * * cd /opt/ratatosk && docker compose run --rm web node dist/cli.js robots/jobs.json --json >> /var/log/ratatosk/jobs.log 2>&1
```

A run that comes back `empty` or `broken` exits non-zero and says why, so a failure is visible to
whatever watches the exit code — and `--repair` rebuilds the scraper and shows what changed:

```bash
docker compose run --rm web node dist/cli.js robots/jobs.json --repair
```

On an installation with accounts, the command line needs to know whose scrapers it is running: make a key
in the view and pass it as `RATATOSK_TOKEN`. For driving it from n8n or anything else that already
schedules and delivers, see [n8n.md](n8n.md).
