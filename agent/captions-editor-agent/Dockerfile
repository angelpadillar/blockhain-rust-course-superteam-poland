FROM node:22.19.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npx playwright-core install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fluxbox ffmpeg tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/assets /ms-playwright \
    && cp -a /root/.cache/ms-playwright/. /ms-playwright/ \
    && rm -rf /root/.cache/ms-playwright \
    && chown -R node:node /app/data /app/assets /ms-playwright
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node config ./config
ENV NODE_ENV=production EDITOR_DATA_DIR=/app/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOST=0.0.0.0 PORT=8792
USER node
EXPOSE 8792 6080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8792/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/main.mjs"]
