# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Non-root user
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY app.js ./
COPY scripts ./scripts

# Writable data directory (mount a PVC here in Kubero for persistence)
RUN mkdir -p /app/data/jobs && chown -R app:app /app

USER app

EXPOSE 8080

CMD ["node", "app.js"]
