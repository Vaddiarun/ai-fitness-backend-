FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY src/ ./src/

# Default environment variables
ENV NODE_ENV=production
ENV PORT=4000
ENV DB_FILE=/app/data/ai-fitness.db

# Expose API port
EXPOSE 4000

# Persistent directory for SQLite database
VOLUME ["/app/data"]

CMD ["npm", "start"]
