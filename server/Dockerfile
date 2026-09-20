# ==============================================================================
# Production Dockerfile for FaceTimeOS WebSocket Signaling & Authority Server
# Target Platform: AWS App Runner / AWS ECS (Fargate) / Container Registry (ECR)
# ==============================================================================

# Build & Runtime Stage: Node.js 22 LTS on Alpine Linux for minimal attack surface
FROM node:22-alpine AS runtime

# Set production environment variables
ENV NODE_ENV=production \
    PORT=3001 \
    DYNAMODB_TABLE_NAME=facetimeos-rooms \
    AWS_REGION=us-east-1

# Create application directory
WORKDIR /app

# Ensure correct permissions for the built-in non-root node user
RUN chown -R node:node /app

# Copy dependency manifests first to leverage Docker layer caching
COPY --chown=node:node package.json package-lock.json ./

# Install production dependencies only with clean reproducible build
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY --chown=node:node src/ ./src/

# Switch to non-root user for security compliance
USER node

# Expose the signaling WebSocket and REST port
EXPOSE 3001

# Production healthcheck using native Node.js fetch against the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3001) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the FaceTimeOS signaling and authority server
CMD ["node", "src/index.js"]
