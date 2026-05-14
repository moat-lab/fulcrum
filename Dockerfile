# syntax=docker/dockerfile:1

# rexecd sidecar binary — built from source so we don't depend on a GHCR
# publish step, and so the produced binary tracks a pinned upstream commit.
FROM golang:1.26-alpine AS rexecd-builder
ARG REXECD_REPO=https://github.com/Mouriya-Emma/rexecd.git
ARG REXECD_REF=7af951fced89c20f39600cf617818753cf9d4198
WORKDIR /src
RUN apk add --no-cache git \
  && git clone "${REXECD_REPO}" . \
  && git checkout "${REXECD_REF}"
RUN CGO_ENABLED=0 GOOS=linux \
  go build -trimpath -ldflags="-s -w" -o /out/rexecd ./cmd/rexecd

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock mise.toml tsconfig.json tsconfig.node.json vite.config.ts components.json drizzle.config.ts ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
RUN mkdir -p cli/server cli/drizzle cli/dist \
  && bun build server/index.ts --target=bun --outfile=cli/server/index.js \
  && bun build cli/src/index.ts --target=bun --outfile=cli/cli.js \
  && cp -r drizzle/* cli/drizzle/ \
  && cp -r dist/* cli/dist/ \
  && cp package.json cli/package.json

FROM oven/bun:1-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    jq \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/cli/package.json ./package.json
COPY --from=build /app/cli/server ./server
COPY --from=build /app/cli/cli.js ./cli.js
COPY --from=build /app/cli/dist ./dist
COPY --from=build /app/cli/drizzle ./drizzle
COPY --from=build /app/entrypoint.sh ./entrypoint.sh

COPY --from=rexecd-builder /out/rexecd /usr/local/bin/rexecd

# fulcrum CLI shell wrapper — keeps the bundled JS at /app/cli.js and exposes
# `fulcrum` on PATH so rexecd's fork+exec("fulcrum", ...) lands.
RUN printf '#!/bin/sh\nexec bun /app/cli.js "$@"\n' > /usr/local/bin/fulcrum \
  && chmod +x /app/entrypoint.sh /usr/local/bin/rexecd /usr/local/bin/fulcrum

ENV FULCRUM_REMOTE_ONLY=true
ENV FULCRUM_DIR=/data/.fulcrum
ENV FULCRUM_PACKAGE_ROOT=/app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7777
ENV REXECD_LISTEN=0.0.0.0:50051

EXPOSE 7777
EXPOSE 50051

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "server/index.js"]
