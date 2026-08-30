# Building a robot

Building is a loop, not one shot. A model that writes a whole scraper from a prompt is guessing, and a
guess that half-works is the worst outcome there is: it produces rows, so nobody checks it. So the
platform gives small steps that each answer with what actually happened.

```
look()                      the page as structure, ~400 tokens          docs/look.md
tryFields(rows, fields)     what those selectors really return, with warnings
paginateProbe(rows)         find the next control AND press it to prove it
buildScenario(...)          assemble and validate — refused here, not at first run
```

## try tells you what is wrong, not just what it got

Every attempt comes back with warnings in plain words, because these are the failures that otherwise
survive into production:

- `"title" is empty in every block` — wrong selector, or the field lives outside the block
- `"price" is missing in 7 of 40 blocks` — a variant of the card the selector does not cover
- `"stock" is identical in every row (In stock…)` — that is a label, not data
- `"town" repeats "city"` — responsive markup showing the same value twice
- `40 blocks matched but no field ever filled` — the row selector is right, the fields are not

## probe presses the button

A pagination rule that was never exercised is a guess. `paginateProbe` finds the candidate control,
uses it, and watches the rows change — on a client-rendered page nothing else proves anything, since
the browser reports no navigation at all. If the rows do not change, the answer is "single page", not
an optimistic rule that would walk page one twenty times.

## save proves before it freezes

A scenario is only written down after it has been run and produced rows. "It didn't save" is a much
better outcome than a robot that returns nothing on Tuesday.

## The draft command

The same steps, driven by heuristics instead of a model:

```bash
npm run draft -- "https://books.toscrape.com/catalogue/page-1.html"
```

```
try: li.col-xs-6.col-sm-4.col-md-3.col-lg-3 → 20 rows of 20 blocks
  warning: "text1" is identical in every row (In stock…) — probably a static label
  dropped as empty of meaning: text1, text2, text3
probe: "li.next a" turned the page and the rows changed
saved examples/books.json — proven on one page: 20 rows
{ "title": "A Light in the Attic", "url": "https://…/a-light-in-the-attic_1000/index.html", "price": "£51.77" }
```

This exists to keep the model honest. Everything the heuristics can settle — which blocks repeat, which
column is a label, whether the button works — is settled before a token is spent, and what reaches the
model is the part that actually needs judgement.
