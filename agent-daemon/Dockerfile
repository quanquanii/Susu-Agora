# susu-agent-daemon — minimal container for self-hosted always-on deployment.
#
# Build:
#   docker build -t susu-agent-daemon .
#
# Run locally with a config file mounted in:
#   docker run --rm -v $(pwd)/agent.config.json:/etc/agent.config.json:ro \
#              susu-agent-daemon
#
# Deploy to fly.io: see README → "Path C: Cloud (always-on, ~$4/mo)".

FROM oven/bun:1.3-alpine AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./
RUN bun build src/index.ts \
    --outfile bin/susu-agent-daemon.mjs \
    --target node \
    --format esm \
    --banner '#!/usr/bin/env node'

# ── runtime stage: just node + the compiled bundle ───────────────────────
FROM node:22-alpine

WORKDIR /app
COPY --from=build /app/bin/susu-agent-daemon.mjs /usr/local/bin/susu-agent-daemon
RUN chmod +x /usr/local/bin/susu-agent-daemon

# Non-root for safety. /data is where decision_log.jsonl + state.json land
# when the user mounts a volume there (see fly.toml [mounts]).
RUN addgroup -S susu && adduser -S susu -G susu \
    && mkdir -p /data \
    && chown -R susu:susu /data
USER susu

# Default command: long-running SSE mode. Override with `--once` for poll mode.
# Config path is bind-mounted at /etc/agent.config.json by convention; users
# can override with their own --config arg.
ENTRYPOINT ["susu-agent-daemon", "--config", "/etc/agent.config.json"]
