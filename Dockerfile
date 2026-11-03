# Stage 1: Official Valhalla base image (C++ routing engine)
FROM ghcr.io/gis-ops/docker-valhalla/valhalla:latest

# Switch to root to install Node.js and dependencies
USER root

# Install Node.js 20, curl, dos2unix
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    dos2unix \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory for Node server
WORKDIR /app

# Copy dependency manifests
COPY package.json tsconfig.json ./
COPY pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* ./

# Install dependencies and build
RUN pnpm install --frozen-lockfile || pnpm install
COPY src ./src
RUN pnpm run build

# Copy pre-built Lagos Valhalla tiles and configs
COPY custom_files /custom_files/
RUN chmod -R 777 /custom_files

# Set up entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN dos2unix /entrypoint.sh && chmod +x /entrypoint.sh

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3010
ENV VALHALLA_URL=http://localhost:8002

EXPOSE 3010

ENTRYPOINT ["/entrypoint.sh"]

