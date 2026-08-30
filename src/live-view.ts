import type { LiveControl } from './drivers/patchright.js';
import { debug } from './log.js';

/**
 * The page in a page.
 *
 * Frames are asked for one at a time and the request waits until there is one — a long poll. The first
 * version of this sent an endless multipart response, the trick every IP camera uses, and it worked
 * perfectly against the server and not at all through a reverse proxy: an endless body is exactly what
 * a proxy buffers, so the frames piled up somewhere in the middle and the picture never appeared. One
 * request per frame is slightly less efficient and survives everything in between.
 *
 * Presses come back as coordinates in the frame's own space, which is what makes this usable over a
 * long wire: you press where you saw the thing, and it lands there even if the picture is behind.
 */
export interface Frame {
  data: string;
  width: number;
  height: number;
  /** Counts up. A viewer asks for anything newer than what it has, and waits when there is nothing. */
  seq: number;
}

interface Stream {
  control: LiveControl;
  last?: Frame;
  seq: number;
  waiting: Set<(frame: Frame) => void>;
  started: boolean;
}

const streams = new Map<string, Stream>();

/**
 * A running commentary on the live view, off unless asked for. This part talks to a browser through a
 * protocol, across a proxy, into somebody else's tab — when it goes quiet there is nothing to look at
 * afterwards, so there has to be a way to watch it happen.
 */
export function liveLog(what: string, detail?: Record<string, unknown>): void {
  debug(`live: ${what}`, detail);
}

/** How long a waiting request is held before it is answered with "nothing new". */
const HOLD_MS = Number(process.env['RATATOSK_FRAME_HOLD_MS'] ?? 20_000);

export function liveStream(token: string): Stream | undefined {
  return streams.get(token);
}

export function rememberLive(token: string, control: LiveControl): void {
  streams.set(token, { control, seq: 0, waiting: new Set(), started: false });
  liveLog('remembered', { token: token.slice(0, 6) });
}

export async function forgetLive(token: string): Promise<void> {
  const stream = streams.get(token);
  if (!stream) return;
  streams.delete(token);
  stream.waiting.clear();
  await stream.control.stop().catch(() => undefined);
}

/**
 * The next frame after the one the viewer already has.
 *
 * The screencast is started by the first request and then runs for everyone: frames are produced only
 * when the page actually repaints, so a still page costs nothing and a busy one costs what it must.
 */
export async function nextFrame(token: string, since: number): Promise<Frame | undefined> {
  const stream = streams.get(token);
  if (!stream) return undefined;

  if (!stream.started) {
    stream.started = true;
    liveLog('starting the screencast', { token: token.slice(0, 6) });
    const starting = stream.control.watch((frame) => {
      liveLog('frame from the screencast', { bytes: frame.data.length, width: frame.width });
      const next: Frame = { ...frame, seq: ++stream.seq };
      stream.last = next;
      for (const waiter of stream.waiting) waiter(next);
      stream.waiting.clear();
    });

    // Starting a screencast talks to a browser, and a browser can be slow or stuck. Whatever it is
    // doing, it must not hold this request open with no answer: the viewer would sit in front of
    // "waiting for the first frame" with nothing to retry against. It asks again in a moment instead.
    const gaveUp = Symbol('slow');
    const raced = await Promise.race([
      starting.then(() => undefined),
      new Promise((resolve) => setTimeout(() => resolve(gaveUp), 4000)),
    ]).catch(() => gaveUp);
    starting.catch(() => {
      stream.started = false; // it did not start after all; the next look tries again
    });
    liveLog(raced === gaveUp ? 'the screencast is slow to start' : 'the screencast started', {
      haveFrame: Boolean(stream.last),
    });
    if (raced === gaveUp && !stream.last) return undefined;
  }

  if (stream.last && stream.last.seq > since) return stream.last;

  // Still nothing to show. Rather than hold the request open in front of a page that may simply never
  // repaint, take a picture of it now — this is the difference between a viewer that works on any page
  // and one that works only on pages that happen to be busy.
  if (!stream.last) {
    liveLog('nothing yet — taking a picture outright');
    const shot = await stream.control.still().catch((error) => {
      liveLog('taking a picture failed', { why: String(error).slice(0, 120) });
      return undefined;
    });
    liveLog('picture taken', { got: Boolean(shot) });
    if (shot) {
      stream.last = { ...shot, seq: ++stream.seq };
      return stream.last;
    }
  }

  return new Promise<Frame | undefined>((resolve) => {
    const waiter = (frame: Frame): void => {
      clearTimeout(timer);
      resolve(frame);
    };
    const timer = setTimeout(() => {
      stream.waiting.delete(waiter);
      resolve(undefined); // nothing repainted; the viewer asks again
    }, HOLD_MS);
    timer.unref?.();
    stream.waiting.add(waiter);
  });
}

/** The viewer itself: one file, no build step, no dependency — it has to work when nothing else does. */
export function viewerPage(token: string, url: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape_(url)} — Ratatosk</title>
<link rel="stylesheet" href="/styles.css">
<style>
  /* The app's own sheet does the type and the colours; this is only what a screen in a page needs. */
  body { padding: 0; }
  main { max-width: none; padding: 0; }
  .bar { display: flex; gap: 14px; align-items: center; padding: 12px 18px; border-bottom: 1px solid var(--edge); flex-wrap: wrap; }
  .bar .where { color: var(--signal); font-family: var(--mono); font-size: 13px; }
  #hint { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
  #stage { display: flex; justify-content: center; padding: 16px; }
  #screen {
    max-width: 100%;
    cursor: crosshair;
    /* Otherwise the browser drags the picture itself, ghost and all, instead of the page inside it. */
    user-select: none;
    -webkit-user-drag: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: var(--surface);
    min-height: 240px;
    min-width: 320px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
  }
  .keys { display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--edge); flex-wrap: wrap; align-items: center; }
  .keys .meta { margin: 0; }
</style>
</head>
<body>
<div class="bar">
  <i class="mark" aria-hidden="true">ᚱ</i>
  <b class="where">${escape_(url)}</b>
  <span class="meta">press straight on the picture — it lands where you pressed, however far behind the frame is</span>
  <span id="hint">waiting for the first frame…</span>
</div>

<div id="stage"><img id="screen" alt="the page" draggable="false"></div>

<div class="keys">
  <input type="text" id="text" placeholder="type here, then Enter — goes to whatever the page has focused">
  <button data-key="Enter">Enter</button>
  <button data-key="Tab">Tab</button>
  <button data-key="Backspace">Backspace</button>
  <button data-key="Escape">Esc</button>
  <span class="meta">scroll</span>
  <button data-scroll="-600">▲</button>
  <button data-scroll="600">▼</button>
  <button class="primary" id="done">Save and close</button>
</div>

<script>
const token = ${JSON.stringify(token)};
const screen = document.getElementById('screen');
const hint = document.getElementById('hint');

const send = (body) =>
  fetch('/live/' + token + '/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);

// One request per frame, each waiting for the next repaint. Nothing here assumes that whatever sits
// between this page and the server will pass an endless response along, because the last one did not.
let seq = 0;
let frames = 0;
let shown;

async function pull() {
  for (;;) {
    try {
      const answer = await fetch('/live/' + token + '/frame?since=' + seq);
      if (answer.status === 404) {
        hint.textContent = 'the session is over';
        return;
      }
      if (answer.status === 204) {
        // Nothing repainted. Say so, or a still page is indistinguishable from a broken one.
        if (!frames) hint.textContent = 'the page is still — nothing has changed yet';
        continue;
      }
      seq = Number(answer.headers.get('x-seq') || seq);
      const blob = await answer.blob();
      if (shown) URL.revokeObjectURL(shown);
      shown = URL.createObjectURL(blob);
      screen.src = shown;
      hint.textContent = ++frames + ' frames';
    } catch {
      hint.textContent = 'lost the connection — retrying';
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
void pull();

// The frame is drawn at whatever size the window allows; the page underneath has its own. One ratio
// between them is all that separates a press here from a press there.
const inPage = (event) => {
  const box = screen.getBoundingClientRect();
  const scale = screen.naturalWidth / box.width;
  return { x: Math.round((event.clientX - box.left) * scale), y: Math.round((event.clientY - box.top) * scale) };
};

// Press, drag, release — not just a click. A scrollbar thumb, a slider, a map: everything drawn to be
// dragged needs the button to stay down while the pointer moves, and the page to be told that it is.
let held = false;
let movedAt = 0;

screen.addEventListener('dragstart', (event) => event.preventDefault());

screen.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  held = true;
  screen.setPointerCapture(event.pointerId);
  const point = inPage(event);
  hint.textContent = 'pressed ' + point.x + ', ' + point.y;
  void send({ type: 'down', ...point });
});

screen.addEventListener('pointermove', (event) => {
  // A pointer that is not holding anything needs no traffic; a held one is throttled to what a page
  // can actually use.
  if (!held || Date.now() - movedAt < 40) return;
  movedAt = Date.now();
  void send({ type: 'move', ...inPage(event), held: true });
});

const release = (event) => {
  if (!held) return;
  held = false;
  void send({ type: 'up', ...inPage(event) });
};

screen.addEventListener('pointerup', release);
screen.addEventListener('pointercancel', release);

// A trackpad sends dozens of tiny deltas a second; forwarded one by one each moves the page by a
// pixel. They are gathered up — but on a timer that is never reset, because a finger that keeps
// moving keeps resetting a timer that waits for it to stop, and then nothing is ever sent at all.
let pending = 0;
let at = { x: 0, y: 0 };
let pushing = null;

const flush = () => {
  pushing = null;
  const dy = pending;
  pending = 0;
  if (dy) void send({ type: 'wheel', x: at.x, y: at.y, dy });
};

screen.addEventListener('wheel', (event) => {
  event.preventDefault();
  pending += event.deltaY * (event.deltaMode === 1 ? 33 : 1);
  at = inPage(event);
  if (!pushing) pushing = setTimeout(flush, 50);
}, { passive: false });

for (const button of document.querySelectorAll('[data-scroll]')) {
  button.addEventListener('click', () => {
    const middle = { x: Math.round(screen.naturalWidth / 2), y: Math.round(screen.naturalHeight / 2) };
    void send({ type: 'wheel', ...middle, dy: Number(button.dataset.scroll) });
  });
}

document.getElementById('text').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const field = event.target;
  if (field.value) void send({ type: 'write', text: field.value });
  void send({ type: 'key', name: 'Enter' });
  field.value = '';
});

// Closing the browser is what writes the profile — so the button that ends this says exactly that,
// and it lives here rather than on the tab you came from.
document.getElementById('done').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'saving…';
  const answer = await fetch('/live/' + token + '/done', { method: 'POST' }).catch(() => undefined);
  const saved = answer && answer.ok;
  hint.textContent = saved ? 'saved — this tab can be closed' : 'could not save; try Close the browser on the other tab';
  button.textContent = saved ? 'saved' : 'failed';
  if (saved) screen.style.opacity = '0.35';
});

for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('click', () => void send({ type: 'key', name: button.dataset.key }));
}
</script>
</body>
</html>`;
}

function escape_(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return map[character]!;
  });
}
