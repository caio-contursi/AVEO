# Aveo Compliance Desk

Prova de conceito para o hackathon Colosseum (Superteam BR): uma atestação SAS sintética reutilizada em dois tokens Token-2022, cada um com sua política, aplicada on-chain por um Transfer Hook. Um Desk mostra os incidentes de elegibilidade e acompanha a correção.

> Provas sintéticas; demo devnet; sem KYC real.

Planos: [`docs/plano-execucao.md`](docs/plano-execucao.md) (completo) e [`docs/algoritmo-execucao.md`](docs/algoritmo-execucao.md) (versão simplificada).
Contrato entre equipes: [`docs/interface-v2.md`](docs/interface-v2.md).

## Estado atual

| Parte | Estado |
|---|---|
| `programs/aveo-hook` | Policy, binding, extra metas e `execute`. `set_binding` confere titular e SAS; o `execute` recusa par não aceito (`6005`) e fato ausente (`6012`). Signer que não é o emissor recebe `UnauthorizedIssuer` (`6015`) |
| `packages/contracts` | Tipos e erros compartilhados, inclusive renovação de vários mints numa transação |
| `packages/sas-client` | Corte do nome SAS em 32 bytes, igual ao sas-lib e ao hook |
| `packages/backend-aveo` | Mints da renovação, regra de incidente e histórico SQLite do `scan:once` |
| `packages/backend-mpl` | Esqueleto que responde `BackendNotIntegrated` (rota A, até o gate A) |
| `app/` | Desk. O diagnóstico, o plano e a verificação rodam no navegador, sobre o RPC |
| `config/programs.json` | IDs fixos do hook, do SAS e do Token-2022. Mints da demo saem do `pnpm fixtures`, não de um manifest inventado |

O programa **não está implantado em devnet**. O ID `ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33` está fixado no `declare_id!` e no `Anchor.toml`. A keypair correspondente não está no Git. Não rode `anchor keys sync`: isso trocaria o ID. A demo local carrega o `.so` compilado nesse endereço.

### Compute units (localnet, 02/10/2026)

| Operação | Compute units |
|---|---|
| Transferência Token-2022 com o hook (simulação, X → Y, 1 ALFA) | 73.596 |
| `set_binding` confirmado (Alfa e Beta) | 20.920–20.921 |
| `set_binding` simulado | 21.070–21.071 |

Dois `set_binding` na mesma transação cabem no limite. A medição é de simulação/execução no validador local, não um teto prometido.

## Pré-requisitos (versões testadas)

| Ferramenta | Versão |
|---|---|
| Node | 22.x |
| pnpm | 10.x |
| Rust | stable (testado 1.98) |
| Solana CLI (Agave) | 2.3.0 |
| Anchor CLI | 0.32.1 |
| Solana platform-tools | v1.53 |

### Instalação do programa (Linux / macOS, com Rust e Solana na máquina)

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Linux: bibliotecas de sistema exigidas pelo Anchor
sudo apt-get install -y libudev-dev pkg-config libssl-dev

# Anchor CLI
cargo install --git https://github.com/solana-foundation/anchor --tag v0.32.1 anchor-cli --locked
```

### Windows

Não é preciso instalar Rust nem a Solana CLI. O Desk sobe o validador e compila o hook num container Docker. O passo a passo está em [`app/README.md`](app/README.md) (seção "Execução contra o validador local"). Resumo:

```bash
pnpm install
# na pasta app/, com Docker aberto e AVEO_DEV_HOME apontando para um disco com ~5 GB
pnpm solana:build
pnpm solana:validator
pnpm fixtures
pnpm dev
```

A primeira compilação baixa o Agave 2.3.0 e as platform-tools. O repositório é montado só para leitura.

## Rodando

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev                # Desk em http://localhost:5173
pnpm fixtures           # cenário local (validador já no ar)
pnpm scenario -- status
pnpm scan:once          # incidentes em app/.dev/incidents.sqlite
```

`pnpm build:program` (Linux/macOS, com a toolchain instalada) usa `cargo build-sbf --tools-version v1.53` em vez de `anchor build`, porque o compilador que vem com a Solana CLI 2.3.0 não entende dependências recentes (edition 2024). No Windows, o equivalente é `pnpm --filter @aveo/app solana:build`.

Não rode `anchor keys sync`. O program ID já está no código. A keypair de deploy não é versionada; sem ela não há deploy nesse endereço em devnet.

## Estrutura

```
programs/aveo-hook/     F1 Porteiro: policy, binding, hook
packages/contracts/     tipos e erros compartilhados
packages/sas-client/    nome SAS de 32 bytes (emissão em app/scripts, via sas-lib)
packages/backend-aveo/  renovação em lote, regra de incidente, SQLite
packages/backend-mpl/   esqueleto not-integrated
app/                    Desk e scripts fixtures / scenario / scan:once
config/                 IDs dos programas, sem mints inventados
docs/                   planos, interface, threat model
config/                 manifests de deploy (sem secrets)
```
