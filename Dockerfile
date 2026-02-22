FROM node:20-alpine

# better-sqlite3 needs build tools for native compilation
RUN apk add --no-cache python3 make g++ ca-certificates curl git docker-cli docker-compose

WORKDIR /app/server

# Copy package files first for layer caching
COPY server/package*.json ./
RUN npm ci --omit=dev

# Copy server source
COPY server/ ./

# Create volume mount points (data/ separate from db/ which has schema.js code)
RUN mkdir -p /app/data updates

ENV NODE_ENV=production
ENV POCKET_IT_DOCKER=true
ENV POCKET_IT_PORT=9100
ENV POCKET_IT_DATA_DIR=/app/data

EXPOSE 9100

# Use wrapper.js for auto-restart support
CMD ["node", "wrapper.js"]
