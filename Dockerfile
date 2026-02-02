# Build stage
FROM node:20-slim AS builder

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y openssl libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install all dependencies (including dev for build)
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source files
COPY tsconfig.json ./
COPY src ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-slim

# Install OpenSSL for Prisma runtime
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install production dependencies only
RUN npm ci --only=production

# Generate Prisma client for production
RUN npx prisma generate

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => { if(r.statusCode !== 200) process.exit(1); })" || exit 1

# Start the application
CMD ["node", "dist/server.js"]
