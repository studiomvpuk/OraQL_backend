# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma client
RUN npm run prisma:generate

# Build application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy Prisma files
COPY prisma ./prisma

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Set environment to production
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Determine which command to run based on BUILD_TARGET env variable
# Default is API, can be set to WORKER for background job processing
ENV BUILD_TARGET=api

CMD if [ "$BUILD_TARGET" = "worker" ]; then \
      node dist/worker.js; \
    else \
      node dist/main.js; \
    fi
