# Susurration — single-image deploy.
# Two build stages, one runtime image:
#   1. web-builder: vite-build the React landing page → /app/web/dist
#   2. runtime: bun + backend src + migrations + the static web/dist above
#
# At runtime the backend (Hono) serves /api/* AND the SPA — single hostname,
# single SSL cert. SUSU_SERVE_WEB=1 + SUSU_WEB_ROOT=/app/web/dist tells it to.
#
# The repo's mono-style relative imports (`../shared/agent-doc.ts`) need
# `shared/` to live next to `web/` and `backend/`, so we preserve that
# directory structure inside the image.

# ─── Stage 1: build the web landing ───────────────────────────────────────
FROM oven/bun:1.3 AS web-builder
WORKDIR /app

# Workspace root + shared module
COPY package.json bun.lock ./
COPY shared/ ./shared/
COPY web/ ./web/

# Install web deps and build (Vite reads vite.config.ts; output in web/dist)
RUN cd web && bun install --frozen-lockfile && bun run build

# ─── Stage 2: backend runtime + bundled web ─────────────────────────────
FROM oven/bun:1.3
WORKDIR /app

# Workspace skeleton
COPY package.json bun.lock ./
COPY shared/ ./shared/
COPY backend/ ./backend/

# Install backend deps (production-only, smaller image)
RUN cd backend && bun install --frozen-lockfile --production

# Pull the built SPA from stage 1
COPY --from=web-builder /app/web/dist ./web/dist

# Backend reads ../shared/agent-doc.ts at runtime; cwd = backend ensures the
# relative path resolves correctly. Migrations live next to src/ already.
WORKDIR /app/backend

# Tell the server to serve the static SPA from the absolute path baked above.
ENV SUSU_SERVE_WEB=1
ENV SUSU_WEB_ROOT=/app/web/dist

EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
