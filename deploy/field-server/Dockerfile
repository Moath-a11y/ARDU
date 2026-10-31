FROM node:20-alpine
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev
COPY backend/ ./
ENV BARQ_MODE=field
ENV BARQ_ENABLE_USB=0
ENV BARQ_ENABLE_PINGGY=0
ENV BARQ_RELAY_PORT=5050
EXPOSE 4000 4001 5050
CMD ["node", "server.js"]
