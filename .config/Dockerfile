# syntax=docker/dockerfile:1
# The `syntax` line is required: the install step below uses a BuildKit secret
# mount, which the legacy builder does not understand.

FROM oven/bun:1-alpine AS builder

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache nodejs

COPY package.json bun.lock tsconfig.json ./

# The preinstall guard runs before install, so it has to be in the image first.
COPY scripts/check-registry-auth.mjs ./scripts/

# ⚠ UNVERIFIED — NEEDS REVISITING (Stage 1 deferred this deliberately).
#
# This mount was built when the credential lived in an .npmrc auth line. The
# mechanism moved to ~/.bunfig.toml, and the mount was updated to match, but
# NEITHER PATH HAS BEEN EXERCISED: no Docker build has been run since. Two
# assumptions in particular are untested:
#
#   1. that bun reads $HOME/.bunfig.toml here, i.e. that HOME really is /root
#      in the oven/bun:1-alpine builder;
#   2. that `bun install -c <path>` would work as the HOME-independent
#      alternative — a probe of that flag produced no registry request at all,
#      so it is not known to work.
#
# A BuildKit secret rather than an ARG is not in doubt: an ARG's value is
# recorded in the image history and `docker history` prints it, and this image
# publishes to ghcr.io/mindcollaps/calendry — a real leak, not a theoretical
# one. A secret mount leaves nothing in any layer.
#
#   docker build --secret id=bunfig,src=$HOME/.bunfig.toml -f .config/Dockerfile .
#
# Verify before relying on this in CI or a release build.
RUN --mount=type=secret,id=bunfig,target=/root/.bunfig.toml \
    bun install

COPY . .
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" bun run prisma generate && bun run prepare && node node_modules/nuxt/bin/nuxt.mjs build


FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apk add --no-cache wget

RUN npm install -g prisma

RUN addgroup -S app && adduser -S app -G app

RUN chown app:app /app

COPY --chown=app:app --from=builder /app/.output ./.output
COPY --chown=app:app --from=builder /app/public ./public
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app prisma.config.js ./prisma.config.js
COPY --chown=app:app .config/wordlists ./.config/wordlists

COPY --chown=app:app .config/entrypoint.sh ./entrypoint.sh

RUN chmod +x ./entrypoint.sh

USER app

EXPOSE 3000

CMD ["./entrypoint.sh"]
