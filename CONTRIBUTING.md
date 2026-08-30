# Contributing

Thanks for the interest. Two things to know before you open a pull request.

## CLA

Contributions are accepted only under a Contributor License Agreement. By submitting a pull request you
assign the copyright in your contribution to the project owner, who may license the combined work under
both the Sustainable Use License and commercial terms.

Without this the commercial edition becomes impossible, quietly and irreversibly — which is exactly the
trap this project was built to avoid.

## Scope

This project is written from its own requirements and from Playwright's documentation. Do not port,
paste, or translate code from other scraping platforms into it, and do not open their sources while
working on the engine. Ideas and documented behaviour are fine; expression is not.

## Tests

Two suites, answering two different questions.

`npm test` — are the parts right? Vitest over the source, seconds, no browser and no network. It must
be green before a change is pushed. `npm run coverage` adds a coverage floor: a ratchet set at what is
covered today, so a change that covers less fails. Raise it when you add tests; never lower it to make
a build pass.

`npm run e2e` — does the product work? Playwright drives a real browser against the real server and a
job board that exists only for these tests (`e2e/fixture-site.mjs`). An account is made, a robot is
built, run and found in its own history — the path a person actually walks.

Neither touches the internet. A suite that depends on somebody else's site fails when somebody else
deploys, and a test that fails for reasons of its own teaches people to ignore tests.

What each part is for, so a new test lands in the right place:

- `test/web-api.test.mjs` — the HTTP API of the real server: routes, statuses, what an answer contains,
  and that one account never sees another's things.
- `test/web-render.test.mjs` — the markup, built by pure functions from typed data. A card that must
  show something after a button is pressed is proved here.
- `test/wiring.test.mjs` — the front-end's two halves compared as text: every control the markup emits
  has a handler, and every handler puts its answer on the screen. This is what catches a dead button.
- everything else — the engine: scenarios, quality, repair, robots, auth, proxies, the SOCKS5 bridge.

A bug that reached a person is a missing test. Write that one first.
