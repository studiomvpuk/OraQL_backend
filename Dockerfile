# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install OpenSSL for Prisma engine at runtime
RUN apk add --no-cache openssl

# Install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy Prisma schema and generate client in production context
COPY prisma ./prisma
RUN npx prisma generate

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Set environment to production
ENV NODE_ENV=production

# Expose port
EXPOSE 4000

# Run migrations then start the API server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
