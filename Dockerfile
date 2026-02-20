FROM node:20-alpine

# better-sqlite3 needs build tools for native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app/server

# Copy package files first for layer caching
COPY server/package*.json ./
RUN npm ci --omit=dev

# Copy server source
COPY server/ ./

# Create volume mount points
RUN mkdir -p db updates

ENV NODE_ENV=production
ENV POCKET_IT_DOCKER=true
ENV POCKET_IT_PORT=9100

EXPOSE 9100

# Use wrapper.js for auto-restart support
CMD ["node", "wrapper.js"]
