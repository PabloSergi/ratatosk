# Chromium needs its system libraries, so the browser is installed with --with-deps at build time
# rather than discovered to be missing on the first run.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
# The front-end is type-checked against the engine and bundled into public/ at image build time.
RUN npm install typescript@^5.6.0 esbuild@^0.28.0 --no-save \
    && npx tsc -p tsconfig.json \
    && npx tsc -p web/tsconfig.json \
    && NODE_ENV=production node scripts/build-web.mjs \
    && npm prune --omit=dev

RUN npx patchright install --with-deps chromium

# A headless browser is the thing anti-bot systems look for. Xvfb lets Chromium run for real on a
# machine with no screen, which is the difference between "Just a moment…" and the actual page.
#
# x11vnc and websockify are for the other half of that: a person taking the browser over for a minute
# — to pass a check meant for a human, to sign in, to accept something. The screen is already there;
# these only make it reachable.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth x11vnc websockify novnc \
    && rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /usr/local/bin/
COPY rules ./rules
COPY examples ./examples

# Robots are data, not code: mount this to keep them across deploys.
VOLUME ["/app/robots"]

ENV NODE_ENV=production
ENV RATATOSK_HEADED=1
ENV RATATOSK_PROFILES=/app/profiles
VOLUME ["/app/profiles"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/mcp/server.js"]
