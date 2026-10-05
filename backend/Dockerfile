FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@10.11.0 --activate \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]
