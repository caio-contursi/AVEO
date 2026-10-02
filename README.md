# Aveo Compliance Desk

Prova de conceito para o hackathon Colosseum (Superteam BR): uma atestação SAS sintética reutilizada em dois tokens Token-2022, cada um com sua política, aplicada on-chain por um Transfer Hook. Um Desk mostra os incidentes de elegibilidade e acompanha a correção.

> Provas sintéticas; demo devnet; sem KYC real.

Planos: [`docs/plano-execucao.md`](docs/plano-execucao.md) (completo) e [`docs/algoritmo-execucao.md`](docs/algoritmo-execucao.md) (versão simplificada).
Contrato entre equipes: [`docs/interface-v2.md`](docs/interface-v2.md).

## Estado atual

| Parte | Estado |
|---|---|
| `programs/aveo-hook` | `init_policy`, `update_policy`, `init_extra_metas`, `set_binding` e `execute` (SAS real, extra metas, fail-closed). Aceite P0 ainda exige transferência on-chain |
| `packages/contracts` | Tipos e erros compartilhados (TypeScript) |
| `packages/backend-mpl` | Esqueleto que responde `BackendNotIntegrated` |
| `packages/sas-client`, `packages/backend-aveo`, `app`, `scripts`, `tests` | Vazios |

## Pré-requisitos (versões testadas)

| Ferramenta | Versão |
|---|---|
| Node | 22.x |
| pnpm | 10.x |
| Rust | stable (testado 1.98) |
| Solana CLI (Agave) | 2.3.0 |
| Anchor CLI | 0.32.1 |
| Solana platform-tools | v1.53 |

### Instalação (Linux / macOS)

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Linux: bibliotecas de sistema exigidas pelo Anchor
sudo apt-get install -y libudev-dev pkg-config libssl-dev

# Anchor CLI
cargo install --git https://github.com/solana-foundation/anchor --tag v0.32.1 anchor-cli --locked
```

## Rodando

```bash
pnpm install
pnpm typecheck          # pacotes TypeScript
pnpm build:program      # programa on-chain + IDL em target/idl/
```

`pnpm build:program` usa `cargo build-sbf --tools-version v1.53` em vez de `anchor build`, porque o compilador que vem com a Solana CLI 2.3.0 não entende dependências recentes (edition 2024).

O program ID em `declare_id!` e em `Anchor.toml` vem de `target/deploy/aveo_hook-keypair.json`, que não é versionado. Quem clonar pela primeira vez deve rodar `anchor keys sync` e compilar de novo.

## Estrutura

```
programs/aveo-hook/     F1 Porteiro: policy, binding, hook
packages/contracts/     tipos e erros compartilhados
packages/sas-client/    F2 Cartório: credentials, schemas, atestações
packages/backend-aveo/  F3 Cérebro do Painel: inspect / plan / verify
packages/backend-mpl/   esqueleto not-integrated
app/                    F4 Vitrine: Desk em React
scripts/                bootstrap, scan:once, transferência fora da UI
tests/onchain/          matriz T01–T17
tests/client/           testes do Desk
docs/                   planos, interface, threat model
config/                 manifests de deploy (sem secrets)
```

## Regras

- Nunca versionar chaves, `.env` ou seed phrases.
- Nunca inventar program ID, offset ou versão de SDK: registrar a fonte em `docs/`.
- Mudanças em `docs/interface-v2.md` ou `programs/` só por PR aprovado pelo líder.
