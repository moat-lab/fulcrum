# syntax=docker/dockerfile:1

FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock mise.toml tsconfig.json tsconfig.node.json vite.config.ts components.json drizzle.config.ts ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
RUN mkdir -p cli/server cli/drizzle cli/dist \
  && bun build server/index.ts --target=bun --outfile=cli/server/index.js \
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
COPY --from=build /app/cli/dist ./dist
COPY --from=build /app/cli/drizzle ./drizzle
COPY --from=build /app/entrypoint.sh ./entrypoint.sh

RUN chmod +x /app/entrypoint.sh

ENV FULCRUM_REMOTE_ONLY=true
ENV FULCRUM_DIR=/data/.fulcrum
ENV FULCRUM_PACKAGE_ROOT=/app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7777

EXPOSE 7777

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "server/index.js"]
