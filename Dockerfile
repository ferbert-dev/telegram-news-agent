FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiles the TypeScript runtime. Kept as its own stage so that `typescript`
# and the rest of the devDependencies are installed here and never reach the
# final image.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build:nest

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node db ./db
# The compiled NestJS runtime. Shipped so that a cutover is a change of command
# rather than a change of image -- the same artifact CI tested can be started
# either way, and the health CLI can be run against a container.
COPY --from=build --chown=node:node /app/dist ./dist

USER node
# Still the legacy entrypoint. Carrying dist/ does not run it: production keeps
# executing src/telegram-bot.js until an explicit cutover ticket changes this
# line (and compose's `command:`, which overrides it anyway).
CMD ["node", "src/telegram-bot.js"]
