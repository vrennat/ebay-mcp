FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY readonly/core.mjs readonly/index.mjs readonly/catalog.json ./readonly/
USER node
ENTRYPOINT ["node", "readonly/index.mjs"]
# STDIO only. Mount a private config and pass --config /path/to/config.json.
# No HTTP listener, exposed port, upstream build, or write-capable entrypoint.
