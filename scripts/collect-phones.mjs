/**
 * Ask a board for the number on every listing a scraper has brought back.
 *
 * A long job by nature: a board hands the number over only when a control is pressed, so this is one
 * page at a time and the whole of a large board takes days. Two things make that survivable — every
 * number found is written down, so a restart skips everything already in hand, and a run that starts
 * hitting a check stops rather than spending the night pressing at a wall.
 *
 * Usage: node scripts/collect-phones.mjs <scraper> "<what the control says>" [--base URL] [--limit N]
 * The key comes from RATATOSK_KEY.
 */
const [scraper, clickText] = process.argv.slice(2);
const base = argOf('--base') ?? 'http://127.0.0.1:5544';
const limit = Number(argOf('--limit') ?? Infinity);
const key = process.env.RATATOSK_KEY;

if (!scraper || !clickText || !key) {
  console.error('usage: RATATOSK_KEY=… node scripts/collect-phones.mjs <scraper> "<control text>" [--base URL] [--limit N]');
  process.exit(2);
}

function argOf(flag) {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function ask(path, body) {
  const answer = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!answer.ok) throw new Error(`${path} answered ${answer.status}`);
  return answer.json();
}

const kept = (await ask('/api/results', { name: scraper })).kept;
if (kept.length === 0) {
  console.error(`${scraper} has kept no runs — run it first`);
  process.exit(1);
}
const run = await ask('/api/results/get', { name: scraper, at: kept[0].at });
const listings = run.rows.map((row) => row.url ?? `https://www.nhatot.com/${row.id}.htm`).filter(Boolean).slice(0, limit);

console.log(`${scraper}: ${listings.length} listings, asking one at a time`);

const tally = { had: 0, got: 0, blank: 0 };
const began = Date.now();
let doorsInARow = 0;

for (const [index, url] of listings.entries()) {
  let answer;
  try {
    answer = await ask('/api/contact', { url, clickText });
  } catch (error) {
    answer = { reason: String(error).slice(0, 80) };
  }

  if (answer.door) {
    doorsInARow++;
    // Three in a row is not a flaky page, it is a closed door: somebody has to walk through it, and
    // pressing at it for another ten hours only teaches the board what we are.
    if (doorsInARow >= 3) {
      console.error(`\nstopped at ${index} of ${listings.length}: ${answer.reason}`);
      console.error('open a takeover on this board, pass the check once, and run this again');
      break;
    }
    continue;
  }
  doorsInARow = 0;

  if (answer.phone) {
    // A listing already in hand comes back instantly; that is how a restart skips the first two days.
    if (Date.now() - Date.parse(answer.at) > 60_000) tally.had++;
    else tally.got++;
  } else {
    tally.blank++;
  }

  const done = index + 1;
  if (done % 25 === 0 || done === listings.length) {
    const perSecond = done / ((Date.now() - began) / 1000);
    const left = (listings.length - done) / perSecond / 3600;
    console.log(
      `${done}/${listings.length}  new ${tally.got}  already had ${tally.had}  no number ${tally.blank}` +
        `  ·  ${(perSecond * 3600).toFixed(0)}/h, ${left.toFixed(1)}h to go`,
    );
  }
}

console.log(`\nfound now ${tally.got}, already had ${tally.had}, no number ${tally.blank}`);
