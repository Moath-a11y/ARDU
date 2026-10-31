# ==============================================================
# BARQ LINK · CLOUD DEPLOYMENT DOCKERFILE
# Node.js 20 LTS + TCP Relay (5050) + REST API (4000)
# المتغيرات المطلوبة (تُضبط في Fly.io Secrets):
#   NO_AUTO_TUNNEL=1          (لا تشغّل Pinggy في السحابة)
#   PUBLIC_URL=https://barq-link.fly.dev
#   PUBLIC_HOST=barq-link.fly.dev
#   TELEGRAM_BOT_TOKEN=...    (اختياري - إشعارات تيليغرام)
#   TELEGRAM_CHAT_ID=...      (اختياري)
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
# 4000: REST API + Web Dashboard
EXPOSE 5050 4000

WORKDIR /app/backend

# السحابة: لا نفق - السيرفر متاح مباشرة على عنوانه الثابت
ENV NO_AUTO_TUNNEL=1

# Start backend services
CMD ["node", "server.js"]
