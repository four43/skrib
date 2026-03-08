# syntax=docker/dockerfile:1

FROM python:3.13-slim AS base

# Install Node.js from official image
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Install git (needed by install-dependencies script)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Frontend node stuff
COPY ./frontend/package*.json ./frontend/
RUN cd frontend && npm install

# Plugin dependencies
COPY ./backend/plugins/four43.room-type-chat/frontend/package*.json ./backend/plugins/four43.room-type-chat/frontend/
RUN cd backend/plugins/four43.room-type-chat/frontend && npm install

ARG INSTALL_DEV_DEPS=1

# Copy backend files
COPY backend/util ./util
COPY backend/pyproject.toml backend/requirements.lock.* ./

# Install Python dependencies
RUN --mount=type=cache,target=/root/.cache/pip \
    if [ "$INSTALL_DEV_DEPS" = "1" ]; then \
        INSTALL_TYPE="dev"; \
    else \
        INSTALL_TYPE=""; \
    fi && \
        ./util/install-dependencies "$INSTALL_TYPE"

COPY ./ ./

# ---------- Dev target (for devcontainer) ----------
FROM base AS dev

# Install Playwright Chromium + system dependencies for E2E tests
RUN cd frontend && npx playwright install --with-deps chromium

EXPOSE 8000 5173
CMD ["sleep", "infinity"]

# ---------- Production target ----------
FROM base AS production

# Build frontend for production
RUN cd ./frontend && npm run build
# Build plugins
RUN cd ./backend/plugins/four43.room-type-chat/frontend && npm run build

EXPOSE 8000 5173
WORKDIR /app/backend
CMD ["python", "-m", "uvicorn", "skrib.main:app", "--host", "0.0.0.0", "--port", "8000"]
