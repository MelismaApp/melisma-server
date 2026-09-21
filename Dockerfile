# syntax=docker/dockerfile:1.7
#
# One stage, because there is nothing to build. The server has no npm dependencies, and Node 24 runs
# the TypeScript directly by stripping the types — so `npm ci` never runs and there is no lockfile
# to keep in step.
#
# Node 24 is a hard floor, not a preference: `node:sqlite` and type stripping are both from it.
#
# Chromium is here for one job: renewing the Spotify web token, which lasts about an hour and can
# only be minted by a browser loading the player. Alpine's package rather than Playwright's bundled
# build — the server drives it over the DevTools protocol directly, which keeps the dependency count
# at zero and means this deployment needs nothing pointed at it.

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# `chromium` pulls its own libraries; the fonts are separate and without them a page renders as
# empty boxes. `ca-certificates` because it talks to Spotify over TLS.
RUN apk add --no-cache \
      tini \
      chromium \
      ca-certificates \
      font-noto \
      font-noto-cjk \
      font-noto-emoji \
 && rm -rf /var/cache/apk/*

ENV BL_CHROMIUM=/usr/bin/chromium-browser

# In a container the only useful bind is every interface — the port is published to the host, or
# reached by kamal-proxy over the Docker network, and neither can see 127.0.0.1 inside here.
ENV BL_HOST=0.0.0.0
ENV BL_PORT=8787

# The database holds the cache *and* the credentials, so it lives on a volume rather than in the
# image layer. Created here with the right owner: a fresh named volume inherits the ownership of
# the directory it shadows, which is the only way the unprivileged user can write to it.
# Still better-lyrics.db, and deliberately: this path names an existing file inside a volume that
# already holds a cache and a set of pasted tokens. Renaming it would start an empty database.
ENV BL_DATA=/data/better-lyrics.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 8787

# The admin page answers unauthenticated — it is only a login form — which makes it a usable
# health check without embedding a key in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# `tini` rather than node as PID 1, and not for signal handling — for reaping.
#
# PID 1 inherits every orphaned process in the namespace and is responsible for reaping them. Node
# does not: it reaps its own children and ignores the strays it adopts, so anything Chromium left
# behind became a permanent zombie holding a PID slot until the container was restarted. Killing the
# process group (see `src/browser/cdp.ts`) stops them being orphaned in the first place; this is the
# backstop for the ones that still slip through, and it is one package.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.ts"]
