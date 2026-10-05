FROM rust:1-bookworm AS mutations
WORKDIR /native
COPY native ./
RUN cargo build --release --locked --bin passshare-mutations

FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@10.11.0 --activate \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

COPY src ./src
COPY --from=mutations /native/target/release/passshare-mutations /usr/local/bin/passshare-mutations

ENV NODE_ENV=production
ENV PASSSHARE_MUTATIONS_BIN=/usr/local/bin/passshare-mutations
EXPOSE 8080

CMD ["npm", "start"]
