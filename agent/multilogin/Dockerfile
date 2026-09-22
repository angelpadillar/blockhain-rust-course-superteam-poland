FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node cli.mjs batch-runner.mjs config.vps.json jobs.example.json accounts.example.json ./
USER node
ENTRYPOINT ["node", "cli.mjs"]
CMD ["doctor", "--config", "config.vps.json"]
