# The Google cache serves the exact previously accepted Docker Official Images.
# Pin bytes as well as the tag; shared Docker Hub runner IPs can hit HTTP 429.
FROM mirror.gcr.io/library/rust:1-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS mutations
WORKDIR /native
COPY native ./
RUN cargo build --release --locked --bin passshare-mutations

FROM mirror.gcr.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

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
