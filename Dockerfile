FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY gastown.config.ts ./
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/migrations ./migrations
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "--dns-result-order=ipv4first", "dist/index.js"]
