FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3210 \
    O_IDLE_HOST=0.0.0.0 \
    O_IDLE_CLOUD=1 \
    O_IDLE_DISABLE_BROWSER=1

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY app.js ./
COPY public ./public
RUN mkdir -p /app/data

EXPOSE 3210
CMD ["node", "app.js"]
