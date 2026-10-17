# PACE RISE : Node — 컨테이너 이미지 (멀티테넌시 4단계, 2026-10-09)
#   docker build -t pacerise .
#   docker run -p 3000:3000 --env-file .env -v pacerise-db:/app/db -v pacerise-uploads:/app/public/uploads -v pacerise-backups:/app/backups pacerise
#   리전(EU 등)에 한 벌 더 올릴 때 같은 이미지를 쓴다. 조직 분리는 코드(organization) 가 하므로 고객마다 이미지를 나누지 않는다.
FROM node:22-bookworm-slim

# canvas(기록 이미지·PDF) 가 쓰는 네이티브 라이브러리 + 한글·일문 글꼴 + 헬스체크용 curl
RUN apt-get update && apt-get install -y --no-install-recommends \
        libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
        fonts-noto-cjk curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p db backups public/uploads && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
