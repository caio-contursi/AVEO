#!/usr/bin/env bash
# Compila o aveo-hook a partir de uma cópia do código (o repositório fica montado só para leitura).
# Usa o mesmo comando do README do backend, com --locked para nunca alterar o Cargo.lock.
set -euo pipefail

work="$DEV_HOME/work"
mkdir -p "$work" "$DEV_HOME/out"
rsync -a --delete --exclude '.git' --exclude 'target' --exclude 'node_modules' --exclude 'app' /src/ "$work/"

cd "$work"
export CARGO_TARGET_DIR="$DEV_HOME/target"
cargo build-sbf --tools-version v1.53 -- --locked

cp "$CARGO_TARGET_DIR/deploy/aveo_hook.so" "$DEV_HOME/out/aveo_hook.so"
sha256sum "$DEV_HOME/out/aveo_hook.so"
