# ==============================================================
# BARQ LINK · CLOUD DEPLOYMENT DOCKERFILE
# Node.js 20 LTS + TCP Relay (5050) + REST API (4000) + WS (4001) + Frontend
# ==============================================================

FROM node:20-alpine

WORKDIR /app

# Copy backend dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# Copy all application files
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Expose ports:
# 5050: TCP Relay (Quectel M25 Cellular Modems)
# 4000: REST API
# 4001: WebSocket Gateway
# 5173: Web Console Dashboard
EXPOSE 5050 4000 4001 5173

WORKDIR /app/backend

# Start backend services
CMD ["node", "server.js"]
