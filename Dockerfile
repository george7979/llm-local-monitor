FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache tzdata openssh-client ipmitool
ENV TZ=Europe/Warsaw

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js entrypoint.sh ./
COPY src/ ./src/
COPY public/ ./public/

RUN chmod +x /app/entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
