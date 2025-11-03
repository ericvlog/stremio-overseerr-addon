FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code AND wait video
COPY . .
COPY public/wait.mp4 ./public/wait.mp4

# Expose the port
EXPOSE 7000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:7000/health || exit 1

# Start the application
CMD ["npm", "start"]
