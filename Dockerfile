# The application image, plus a one-shot migrator.
#
# Two things shape this file. The runtime image runs Next's standalone output,
# which carries only the traced dependencies, so it does not contain npm, the
# TypeScript toolchain, or anything needed to change the database. And schema
# changes need drizzle-kit and tsx, which are devDependencies, so they get their
# own target rather than being dragged into the image that faces the internet.
#
# Both migrators run before the app starts, wired up in compose.yaml.

# Tracks .nvmrc. Alpine because there is no native dependency in the tree: pg
# and linkedom are pure JavaScript.
#
# Pinned by digest, not by tag. `node:26.3-alpine` is republished whenever its
# Alpine base gets a patch, so the same commit rebuilt a month later is a
# different image, and "it worked in CI" stops meaning anything. The digest is
# the multi-arch index, so it still resolves to amd64 in CI and arm64 on a
# developer's Mac. The tag stays in the comment because a digest tells a human
# nothing:
#
#   node:26.3-alpine   # readable name of the digest below
#
# Refresh it deliberately, with:
#
#   podman pull node:26.3-alpine
#   podman image inspect node:26.3-alpine --format '{{index .RepoDigests 0}}'
#
# and check the digest that comes back is the index rather than one platform's
# manifest: `podman manifest inspect <digest>` has to succeed.
ARG NODE_IMAGE=node@sha256:a2dc166a387cc6ca1e62d0c8e265e49ca985d6e60abc9fe6e6c3d6ce8e63f606

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `npm ci` otherwise runs the install and postinstall script of
# every package in the tree, transitively, as part of the build. Nothing here
# needs one. The packages that ship a native binary (esbuild, unrs-resolver,
# @parcel/watcher) get it from a per-platform optional dependency rather than by
# compiling in a postinstall, so they still work. If a future dependency really
# does need its script, add that one package back with
# `npm rebuild <package>` rather than dropping the flag for the whole tree.
RUN npm ci --ignore-scripts

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` imports the auth module to collect route data for
# /api/auth/[...all], and that module reads its configuration at import time and
# throws when it is absent. So the compile needs values present, not correct:
# nothing here opens a connection or reaches Google.
#
# The Google pair is on the list for that reason and not by accident. The auth
# module also refuses a configuration with no way in at all, so a build without
# it fails at page-data collection, not at run time. The CI workflow satisfies
# the same check with AUTH_PASSWORD_LOGIN; here it is the Google pair, so the
# build has the shape the container actually runs with.
#
# These stay in this stage. The runtime image starts from a clean base, and
# compose.yaml refuses to start the app without the real ones.
ENV NODE_ENV=production \
    DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    APP_DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_SECRET=build-time-placeholder-never-used-at-runtime \
    BETTER_AUTH_URL=http://localhost:3000 \
    MCP_RESOURCE=http://localhost:3000/api/mcp \
    GOOGLE_CLIENT_ID=build-time-placeholder \
    GOOGLE_CLIENT_SECRET=build-time-placeholder
RUN npm run build

# Schema changes. Runs once per deploy, then exits.
#
# It is published to the registry beside the runtime image, so it is treated the
# same way: not root, and carrying only what it runs. What that is:
#
#   package.json      the three scripts below, and `type: module`
#   tsconfig.json     the `@/*` paths, which src/db/schema imports through
#   drizzle.config.ts where the schema and the migration folder are
#   drizzle/         the migrations themselves, and their journal
#   scripts/         the three entry points
#   src/db           the schema, and bootstrap.sql
#   src/domain       imported by the schema for the vocabulary types
#   src/lib          scripts/auth-migrate.ts imports src/lib/auth.ts
#
# Everything else the old `COPY . .` brought in, which is to say the whole
# application, the tests and the documentation, was surface with nothing to do.
FROM ${NODE_IMAGE} AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json drizzle.config.ts ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src/db ./src/db
COPY --chown=node:node src/domain ./src/domain
COPY --chown=node:node src/lib ./src/lib
USER node
# Bootstrap creates the least-privileged runtime role, then Drizzle migrates the
# domain tables and Better Auth migrates its own twelve. Order matters: see
# docs/07-phase-0-findings.md section 3.1.
CMD ["sh", "-c", "npm run db:bootstrap && npm run db:migrate && npm run auth:migrate"]

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The node user ships with the image, so the server never runs as root.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
