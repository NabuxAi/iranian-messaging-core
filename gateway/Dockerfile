# Iran Messengers MCP gateway. Build context: the repository root (the
# gateway runs the core's bot operations from ../src).
#   docker build -f gateway/Dockerfile -t iran-messengers-gateway .
# Bot mode only: no browser in this image.
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY gateway/package.json ./gateway/package.json
RUN cd gateway \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY gateway/src ./gateway/src
COPY gateway/static ./gateway/static

RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/gateway
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.mjs"]
