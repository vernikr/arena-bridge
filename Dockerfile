# Hub image for arena-bridge.
#   docker build -t arena-bridge .
#   docker run -d --name arena-hub -p 8788:8788 -v arena-bridge-data:/root/.arena-bridge arena-bridge
# Put it behind Caddy/nginx with TLS: https://bridge.example.com
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
RUN npm install --omit=dev --no-audit --no-fund

ENV ARENA_BRIDGE_HOME=/root/.arena-bridge
VOLUME ["/root/.arena-bridge"]
EXPOSE 8788

ENTRYPOINT ["node", "bin/arena-bridge.mjs", "hub", "--host", "0.0.0.0", "--port", "8788"]
