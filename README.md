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

## Automated local acceptance

Use Node 22 or later. With the local validator running, generate the synthetic
fixtures and run the acceptance checks without opening the Desk:

```bash
pnpm fixtures
pnpm demo:check
pnpm demo:report  # reruns the checks and writes a public JSON receipt
```

`demo:check` checks shared proof reuse, successful transfers, the Alfa/Beta policy
differences, issuer and binding authorization, authorized SAS close, rejected
inbound/outbound transfers with unchanged token balances, grouped incidents, and
wallet-signed renewal across both assets in one transaction. It also removes a
provider from Alfa without affecting Beta, temporarily deactivates Alfa, and
waits for an actual short-lived proof to expire against the validator clock.
Policies and bindings are restored after these checks. Expected failures
are submitted with preflight disabled only in this local runner, so their
signatures and hook errors are recorded in the ledger. It prints `PASS`, `FAIL`,
`NOT_RUN`, and public transaction evidence; any failed expectation returns a
nonzero exit status. Failed transactions still consume synthetic SOL fees.

`demo:report` writes `app/.dev/acceptance-report.json`, an ignored runtime artifact
with timestamps, ordered stage results, public signatures, slots and balances.
Only explicitly allowed evidence fields are saved, never raw process logs,
RPC URLs or private keys. The receipt maps covered scenarios to T01–T17 and
marks incomplete matrix cases `NOT_RUN`; a passing run is not a passing full
security matrix. A failed or interrupted runner cannot produce a passing receipt.
Each execution replaces the previous receipt. These synthetic localnet receipts
are demonstration evidence, not independent attestations or devnet explorer links.

The runner changes synthetic localnet state: it closes X's proofs and creates a
replacement. Regenerate fixtures to restore the original demonstration scenario.
It requires loopback RPC/WebSocket endpoints and a localnet manifest, and does
not deploy programs or authorize use with real assets. A loopback URL alone does
not verify which network a proxy forwards to; use the project's local validator.

```bash
pnpm demo:check --self-test  # checks runner assertions without a validator
pnpm typecheck
pnpm test
pnpm --filter @aveo/app lint
pnpm --filter @aveo/app build
cargo test -p aveo-hook --locked
```

The Rust tests exercise validation functions with account fixtures. The acceptance
runner exercises the deployed local programs. Neither alone proves every scenario
in the T01–T17 matrix or an official MPL-3643 integration.

Local verification on 2026-10-09 used Node 22, Agave 2.3.0 and platform-tools
v1.53: 23 Rust tests passed with the SBF build in the first readiness round.
The second round passed 137 app/script tests, 4 backend tests, the 21-stage
acceptance runner and receipt generation, TypeScript checks, ESLint and the
frontend build. It did not change the Rust program or repeat its earlier build.
The third round passed 223 app/script tests and 4 backend tests, production and
test-project TypeScript checks, ESLint and the frontend build. The 21-stage local
acceptance run remained passing after coherent-readback and bounded-read changes.
The frontend build retains two existing Zod/Rollup annotation warnings; Node 22
also reports its existing experimental SQLite warning during backend tests.
These results establish local behavior, not a devnet deployment or the full
T01–T17 security matrix.

Transaction confirmation now honors the selected commitment (the requested
level of agreement on a transaction), with a single deadline covering status
requests, log requests and polling. Requests are aborted at the deadline, and
timeouts return `unknown`, never success or an automatic transaction resend.
If logs are unavailable for a confirmed failure, the result remains a failure
without inventing a specific hook error. These RPC failure modes are covered by
unit tests, not claimed as complete end-to-end T14 coverage.

Account reads have a 10-second deadline, cancel their pending request and reject
invalid or stale slots and incomplete account lists. Eligibility inspection uses
its first read to discover proof addresses, then rereads policy, mint, binding,
Clock and SAS accounts together. The final decision uses only this shared
observation slot, including the final policy version and chain timestamp. A
binding replaced during discovery returns `unknown`; inspect again rather than
combining the replacement with the previous proof. Display-only proof reads do
not advance the observation slot of a rejected-provider policy decision.

For transfer, binding and policy operations, an unknown submitted transaction
offers **Recheck confirmation** (Portuguese: **Verificar novamente**). This action
only verifies the retained signature using its original plan and backend; it
does not sign or send a new transaction and works with the wallet disconnected.
Evidence labels and decimal precision remain those of the submitted asset,
not a subsequently edited form or a different deployment.
Concurrent actions and resetting an unresolved submission are blocked. Network,
RPC, program, commitment or deployment changes disable rechecking and suppress
links to the wrong network's Explorer. Restore the original context to recheck.
Pending submissions are kept only while the operation component remains mounted;
navigation away or a browser reload loses this in-memory recovery state.
Controller and static-render tests cover these protections; they do not replace
interactive browser testing. A separate live localnet recheck confirmed a
previously submitted transfer, returned two fresh readbacks and made no send calls.

### Proposed backlog issues

- Extract the network adapter and incident model into shared packages so the
  Desk and CLI use the same application layer without importing frontend files.
- Share binary account fixtures between Rust and TypeScript tests to detect
  parser and diagnosis differences before they reach a demonstration or pilot.
- Persist a public pending-submission receipt so a browser reload can resume
  read-only verification of the same signature without storing wallet keys.
- Add controlled RPC fault injection to the local acceptance runner to exercise
  the complete T14 workflow, not only isolated timeout and inconsistency tests.

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
