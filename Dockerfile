# syntax=docker/dockerfile:1

# Extract just package.json/package-lock.json from plugin frontends (preserves directory structure)
FROM busybox AS plugin-pkg
COPY ./backend/plugins/ /plugins/
RUN find /plugins -path '*/frontend/package*.json' -exec sh -c \
    'mkdir -p "/out/$(dirname "$1")" && cp "$1" "/out/$1"' _ {} \; \
    && find /plugins -path '*/frontend/package*.json' -prune -o -type f -print | xargs rm -f 2>/dev/null; true

FROM python:3.13-slim AS base

# Install Node.js from official image
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app

# Frontend node stuff
COPY ./frontend/package*.json ./frontend/
RUN cd frontend && npm install

# Plugin frontend dependencies (auto-discovers all plugins)
COPY --from=plugin-pkg /out/plugins/ ./backend/plugins/
COPY ./frontend/util/install-plugins ./frontend/util/install-plugins
RUN ./frontend/util/install-plugins

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

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p ~/.ssh \
    && ssh-keyscan github.com >> ~/.ssh/known_hosts

# Install Playwright Chromium + system dependencies for E2E tests
RUN cd frontend && npx playwright install --with-deps chromium

EXPOSE 8000 5173
CMD ["sleep", "infinity"]

# ---------- Production target ----------
FROM base AS production

# Build frontend for production
RUN cd ./frontend && npm run build

EXPOSE 8000 5173
WORKDIR /app/backend
CMD ["python", "-m", "uvicorn", "skrib.main:app", "--host", "0.0.0.0", "--port", "8000"]
