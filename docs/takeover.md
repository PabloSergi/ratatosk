# Taking the browser over

Some doors are meant for a person and should stay that way: a check that asks whether you are one, a
login, a consent screen, an age gate. Ratatosk does not try to get a scraper past them. It does the
opposite — it hands you the scraper's own browser for a minute.

    Proxies → Open a page yourself → the address → Open it myself

A tab opens with the browser running on the server. You do the thing by hand. What the site leaves
behind — a cookie, a session — stays in the profile that scraper uses, so its next run arrives as a
returning visitor rather than as a stranger.

## What happens when you save

Pressing **Save and close** writes the profile — that is the whole point of the session, and the cookie
the site left behind is what the scraper will carry from then on. If the door was opened from a
scraper's card, that scraper is put in line to run straight away: somebody who has just passed a check
wants to know whether it worked, and being told to go back and press Run is being asked to finish a job
the product could finish itself.

## Where the button is

Two places, one act. In the build form, for a site you are setting up: paste the address, choose the way
out, press **Open it myself**. And on the card of any scraper whose last run hit a check — there the
address and the proxy come from the scraper itself, because passing a door through the wrong way out
writes a profile that scraper never uses.

## What it is made of

Not a remote desktop. A remote desktop sends pixels of a whole screen and expects your mouse to chase
them; over a long wire that means aiming at where something *was*. This sends frames of the tab itself
and takes back coordinates:

- **A screencast of the page**, through the devtools protocol the browser already speaks. Frames are
  produced only when something actually changes, so a still page costs nothing at all.
- **An endless multipart response** — the trick every IP camera uses — so an ordinary `<img>` shows a
  live tab with no player, no websocket and no library. A viewer that refuses it falls back to single
  frames on a timer by itself.
- **Presses as coordinates.** You press on the picture; the point is dispatched to the page in its own
  coordinate space. **Accuracy stops depending on frame rate** — the press lands where you pressed even
  if the picture is a second behind, because there is no cursor to miss with.
- **Backpressure decides the rate.** While the socket is still swallowing the last frame, the next ones
  are skipped, so a slow link gets fewer *current* frames instead of a growing queue of stale ones.

The whole desktop is still available for the rare case where the browser window itself is what you
need — **Xvfb** gives each session its own screen (several accounts run browsers in one container, and
a shared display would show each of them the others' pages), **x11vnc** makes it readable on loopback
only, and **websockify + noVNC** put it in a tab. That path is the fallback, not the default.

The way in is the Ratatosk server itself, at `/vnc/<token>/`. The token is eighteen random bytes,
handed to the account that started the session and to nobody else — a websocket cannot carry an
`Authorization` header, so the credential lives in the path. Sessions end by themselves after fifteen
minutes (`RATATOSK_TAKEOVER_MS`), and closing one closes the browser, which is what writes the profile.

## The better way: pass it on your own machine

A screen over a wire is never going to feel like your own laptop, and for a gate you meet once there
is no reason to put up with it. So the browser can open here instead, and the session can travel:

    node scripts/pass-gate.mjs --server https://your-ratatosk --url https://site/list --proxy <id>

It signs in as you, asks the server which way out that scraper uses, opens a real Chromium on your
machine **through that same proxy**, and waits. You deal with the gate at the speed of your own
hardware. When you press Enter, the cookies for that site are carried into the profile the scraper uses
on the server, and the scraper's next run arrives as whoever you just were.

Your laptop and the server are not the same kind of computer, and a browser announces that. If the
gate ties its answer to it, run the helper again with `--match-agent` and this browser will introduce
itself the way the scraper's does — the person passing the gate is still you.

The proxy is not optional decoration. These gates tie what they hand you to the address you came
from; pass the check from your home connection and the cookie is worthless to a server in another
country. Same proxy, same address, same session. The helper also compares what the two browsers call
themselves and says so if they differ, because some gates check that too.

## If the picture feels heavy

In a page, VNC is fine for clicking a checkbox, signing in, or accepting something — it is not fine
for half an hour of work. When you need better, forward the port and use a real client:

    ssh -N -L 5937:127.0.0.1:5937 you@your-server

The port is reported when the session starts. It is never exposed by the container; the tunnel is the
only way to it, which is deliberate.

## Licensing

x11vnc (GPL-2) and noVNC (MPL-2) are installed as programs and run as separate processes, and noVNC's
files are served as they are. Nothing here is linked into Ratatosk's own code, so neither licence
reaches it.

## What this is not

It is not a way past a check that a machine is not supposed to pass. There is no solver here, no
service that answers puzzles for money, and no tool that hands one to a model — a scraper that could
get itself past a "prove you are human" gate would be lying about what it is. A person does it, once,
and the scraper goes back to being a machine that only reads pages.
