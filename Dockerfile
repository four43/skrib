# syntax=docker/dockerfile:1

FROM python:3.13-slim

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

# Expose ports (8000 = backend, 5173 = frontend dev)
EXPOSE 8000 5173

# Run the application
# Build frontend for production
RUN cd ./frontend && npm run build
CMD ["python", "-m", "uvicorn", "skrib.main:app", "--host", "0.0.0.0", "--port", "8000"]
