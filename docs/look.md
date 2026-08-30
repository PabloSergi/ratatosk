# look — what the model is shown instead of the page

A listing page is 300–800 KB of markup. No model reads that affordably, and one that tries spends its
attention on `div` soup instead of on decisions. So the platform does the rough structural work itself
and hands over a sketch: **about 400 tokens instead of a hundred thousand.**

```bash
node dist/look-cli.js "https://example.com/jobs"
```

```json
{
  "url": "https://books.toscrape.com/catalogue/page-1.html",
  "title": "Books to Scrape - All products",
  "candidates": [
    {
      "selector": "li.col-xs-6.col-sm-4.col-md-3.col-lg-3",
      "count": 20,
      "fields": [
        { "role": "title", "selector": "h3", "sample": "A Light in the ..." },
        { "role": "price", "selector": "p.price_color", "sample": "£51.77" },
        { "role": "text",  "selector": "p.instock.availability", "sample": "In stock" }
      ]
    }
  ],
  "pagination": { "kind": "link", "selector": "li.next a", "note": "next" },
  "notes": []
}
```

Everything in the sketch is a **proposal**, not a verdict. The platform says "these twenty blocks repeat,
this child looks like a price, the page continues through this control"; the model decides what the rows
actually are and which fields matter. That division is the whole design: structure is mechanical, meaning
is not.

## How a row is recognised

Frequency alone is a trap — the most repeated thing on a page is layout scaffolding, not content. A row
is recognised by structure instead:

- its copies sit under **one parent** rather than scattered across the page
- they are **about the same size** — real rows are uniform, wrappers are not
- each one carries **its own link** and usually its own heading
- the outermost block wins when a parent repeats exactly as often as its child

Everything below the top candidates is dropped: four blocks, eight fields each, is enough for a decision
and cheap enough to send on every step of a build.

## Notes

The sketch flags what changes how the page must be handled, because these are the things that silently
ruin a run:

- lazy images — rows may need scrolling before they are complete
- a consent overlay — a [site rule](../src/rules.ts) should clear it before the walk
- iframes on the page
- a challenge page instead of the content

## Where it goes next

`look` is the first of the build-time tools. The rest of the loop — `try` a selector and see what comes
back, `paginate_probe` the next control, `save` a finished scenario — turns the sketch into a
[scenario](scenario.md) that runs without a model from then on.
