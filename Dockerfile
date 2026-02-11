FROM node:24-alpine AS base

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY .env.example ./.env.example
COPY README.md ./README.md

RUN npm run build

RUN mkdir -p /app/data

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]

