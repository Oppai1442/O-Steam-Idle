FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.client.json ./
COPY src ./src
COPY client ./client
COPY scripts ./scripts
COPY public ./public
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3210 \
    O_IDLE_HOST=0.0.0.0 \
    O_IDLE_CLOUD=1 \
    O_IDLE_DISABLE_BROWSER=1
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
RUN mkdir -p /app/data
EXPOSE 3210
CMD ["node", "dist/src/server.js"]
