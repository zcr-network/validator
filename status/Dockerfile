# ZCore validator — read-only status page (:9055).
# Reads the node over the internal Docker network and serves a small HTML page.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
EXPOSE 9055
CMD ["node", "server.mjs"]
