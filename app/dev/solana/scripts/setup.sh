#!/usr/bin/env bash
# Instala, no volume de desenvolvimento, o Rust (perfil mínimo) e a release oficial do Agave
# (Solana CLI, test validator e cargo-build-sbf). Nada é instalado na imagem.
set -euo pipefail

mkdir -p "$DEV_HOME"

if ! command -v cargo >/dev/null 2>&1; then
  echo "Instalando Rust (stable, perfil mínimo) em $RUSTUP_HOME"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
fi
echo "Rust: $(cargo --version)"

target="$DEV_HOME/solana-release"
if [ ! -x "$target/bin/solana" ]; then
  url="https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2"
  echo "Baixando $url"
  curl -sSfL "$url" -o "$DEV_HOME/solana-release.tar.bz2"
  tar -xjf "$DEV_HOME/solana-release.tar.bz2" -C "$DEV_HOME"
  rm "$DEV_HOME/solana-release.tar.bz2"
fi
echo "Agave: $("$target/bin/solana" --version)"
