# syntax=docker/dockerfile:1.7
#
# One stage, because there is nothing to build. The server has no dependencies, and Node 24 runs
# the TypeScript directly by stripping the types — so the image is the base plus a few hundred KB
# of source, and `npm ci` never runs.
#
# Node 24 is a hard floor, not a preference: `node:sqlite` and type stripping are both from it.

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# In a container the only useful bind is every interface — the port is published to the host, or
# reached by kamal-proxy over the Docker network, and neither can see 127.0.0.1 inside here.
ENV BL_HOST=0.0.0.0
ENV BL_PORT=8787

# The database holds the cache *and* the credentials, so it lives on a volume rather than in the
# image layer. Created here with the right owner: a fresh named volume inherits the ownership of
# the directory it shadows, which is the only way the unprivileged user can write to it.
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

CMD ["node", "src/main.ts"]
