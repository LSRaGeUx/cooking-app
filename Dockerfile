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
ARG NODE_IMAGE=node:26.3-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

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
FROM ${NODE_IMAGE} AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
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
