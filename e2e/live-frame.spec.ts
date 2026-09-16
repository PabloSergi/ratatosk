import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import sharp from 'sharp';

import { openBrowser } from '../src/drivers/patchright.js';
import { forgetLive, nextFrame, rememberLive } from '../src/live-view.js';

/**
 * What the live view actually shows.
 *
 * A login page hands its security check to another site, and another site is painted by another
 * process. Chromium's screencast leaves that part of the picture white — which is how a person ends
 * up staring at an empty box where the check should be. The frame the viewer is served has to carry
 * the whole tab, frames from elsewhere included.
 */
test('a frame from another site is in the picture', async () => {
  const inner = createServer((_request, response) =>
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<body style="margin:0;background:#e01b24"></body>'),
  );
  const outer = createServer((_request, response) =>
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<body style="margin:0;background:#fff"><iframe src="http://127.0.0.1:5713/" style="width:600px;height:300px;border:0"></iframe></body>'),
  );
  await new Promise<void>((done) => inner.listen(5713, '127.0.0.1', done));
  await new Promise<void>((done) => outer.listen(5712, 'localhost', done));

  const profile = mkdtempSync(join(tmpdir(), 'ratatosk-frame-'));
  const session = await openBrowser({ headless: false, profileDir: profile });
  try {
    await session.page.goto('http://localhost:5712/');
    rememberLive('a-token', await session.live!());

    // Frames are asked for one after another, as the viewer asks for them: each call returns the next
    // picture that differs from the last, so this is the page appearing rather than a fixed wait.
    let red = 0;
    let seq = 0;
    for (let look = 0; look < 10 && red === 0; look += 1) {
      const frame = await nextFrame('a-token', seq);
      if (!frame) continue;
      seq = frame.seq;
      const { data, info } = await sharp(Buffer.from(frame.data, 'base64'))
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let at = 0; at < data.length; at += info.channels) {
        if (data[at]! > 180 && data[at + 1]! < 80 && data[at + 2]! < 80) red += 1;
      }
    }
    // The frame is 600×300 of somebody else's site; a blank box would leave none of it.
    expect(red).toBeGreaterThan(100_000);
  } finally {
    await forgetLive('a-token');
    await session.close();
    rmSync(profile, { recursive: true, force: true });
    inner.close();
    outer.close();
  }
});
