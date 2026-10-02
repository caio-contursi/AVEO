# Ambiente de desenvolvimento do front: compila o aveo-hook e roda um validador local.
# Não faz parte do backend. O código do programa é montado somente para leitura em /src.
# A imagem é mínima de propósito: Rust, Agave, toolchain SBF, cache e build ficam no volume
# montado em /opt/aveo-dev (fora do disco do Docker), definido por AVEO_DEV_HOME.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 gcc libc6-dev pkg-config libssl-dev libudev-dev rsync \
  && rm -rf /var/lib/apt/lists/*

ENV AGAVE_VERSION=v2.3.0 \
    DEV_HOME=/opt/aveo-dev \
    RUSTUP_HOME=/opt/aveo-dev/rustup \
    CARGO_HOME=/opt/aveo-dev/cargo \
    PATH=/opt/aveo-dev/cargo/bin:/opt/aveo-dev/solana-release/bin:$PATH

COPY scripts/ /usr/local/bin/aveo/
RUN chmod +x /usr/local/bin/aveo/*.sh

WORKDIR /opt/aveo-dev
