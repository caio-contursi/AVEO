#!/usr/bin/env bash
# Sobe um solana-test-validator com:
#  - aveo-hook compilado localmente, carregado no endereço declarado no programa (declare_id!);
#  - SAS e Token-2022 copiados da devnet, para usar os mesmos binários oficiais da rede.
# O ledger é recriado a cada execução (--reset).
set -euo pipefail

AVEO_HOOK_ID="ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33"
SAS_ID="22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG"
TOKEN_2022_ID="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
out="$DEV_HOME/out"

if [ ! -f "$out/aveo_hook.so" ]; then
  echo "Falta $out/aveo_hook.so. Rode build-program.sh antes." >&2
  exit 1
fi

for pair in "sas:$SAS_ID" "token2022:$TOKEN_2022_ID"; do
  name="${pair%%:*}"
  id="${pair#*:}"
  if [ ! -f "$out/$name.so" ]; then
    echo "Copiando $name ($id) da devnet"
    solana program dump -u devnet "$id" "$out/$name.so"
  fi
done

exec solana-test-validator \
  --reset \
  --ledger /tmp/aveo-ledger \
  --bind-address 0.0.0.0 \
  --rpc-port 8899 \
  --bpf-program "$AVEO_HOOK_ID" "$out/aveo_hook.so" \
  --bpf-program "$SAS_ID" "$out/sas.so" \
  --bpf-program "$TOKEN_2022_ID" "$out/token2022.so"
