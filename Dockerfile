FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data

ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
