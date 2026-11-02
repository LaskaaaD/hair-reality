FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.19.0-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/hair-reality/private \
  && chown node:node /var/lib/hair-reality/private
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# Read from the working directory at runtime: demo media and reference photos, and the sample profile.
COPY public ./public
COPY assets/references ./assets/references
COPY src/server/demo/sample-analysis.json ./src/server/demo/sample-analysis.json
COPY docker/entrypoint.sh /usr/local/bin/hair-reality-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/hair-reality-entrypoint && chmod 755 /usr/local/bin/hair-reality-entrypoint
USER root
ENTRYPOINT ["hair-reality-entrypoint"]
CMD ["node", "dist/server/index.js"]
