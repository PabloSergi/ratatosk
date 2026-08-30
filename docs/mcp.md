# MCP: the main way in

The platform talks to agents directly, and it does so through two surfaces that are deliberately kept
apart.

```bash
npm run build && npm run mcp        # stdio server
```

```json
{
  "mcpServers": {
    "ratatosk": {
      "command": "node",
      "args": ["/path/to/ratatosk/dist/mcp/server.js"],
      "env": { "RATATOSK_TOKEN": "<your token, if this installation has accounts>" }
    }
  }
}
```

The token names the account whose robots this server speaks for — copy it from **token for MCP** in the
web view. Without accounts it is not needed; with accounts, a missing one is refused rather than
quietly showing somebody else's robots. See [accounts](accounts.md).

## Building a robot — five tools, used in a loop

| Tool | What it answers |
|---|---|
| `open(url)` | opened it, cleared what was in the way, here is what to watch out for |
| `look()` | the page as structure: repeating blocks, proposed selectors, field roles, how it continues |
| `try(rows, fields)` | what those selectors really return — and what looks wrong about it |
| `paginate_probe(rows)` | the next control, **pressed**, with proof the rows changed |
| `save(name, …)` | freezes it as a robot, but only after running it and getting rows |

The loop matters more than any single tool. An agent proposes a selector, sees that seven of forty
blocks came back without a title, narrows it, and tries again. That is how the thirteen hand-written
parsers this project grew out of were built — a human iterating — and an agent given the same loop wins
the same way. One-shot generation from a prompt is what the competition does, and it is why their
robots return nothing and call it success.

## Consuming data — two tools, no selectors

| Tool | What it answers |
|---|---|
| `robots()` | which robots exist and what columns each returns |
| `fetch(name, maxPages?)` | the rows |

An agent on this side never learns what a selector is. It asks for jobs from a site and gets jobs. That
is the honest version of "the web as a database".

## Errors are instructions

A failure says what to do next, because a model cannot act on "An error occurred":

```
no page is open — call open(url) first
no robot named "flats". Known robots: books, jobs
not saved: the scenario ran and came back empty — page rendered but ".card" matched nothing.
  Evidence: {"blocksSeen":0,…}. Fix the selectors with try, then save again.
```

## Checking it end to end

```bash
node scripts/mcp-live-check.mjs
```

Drives a real server over stdio through the whole cycle — open, look, try, probe, save, robots, fetch —
against a live site, and finishes by asking for a robot that does not exist to see that the refusal is
useful. Kept out of `npm test` because it needs a browser and the network.
