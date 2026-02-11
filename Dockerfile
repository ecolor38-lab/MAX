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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('node:http');const port=process.env.ADMIN_PANEL_PORT||8787;const req=http.get('http://127.0.0.1:'+port+'/health',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(3000,()=>{req.destroy();process.exit(1);});"

CMD ["node", "dist/index.js"]

