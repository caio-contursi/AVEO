# Aveo Compliance Desk

Proof of concept for the Colosseum hackathon (Superteam BR): one synthetic SAS (Solana Attestation Service) attestation reused across two Token-2022 tokens, each with its own policy, enforced on-chain by a Transfer Hook. A Desk shows eligibility incidents and tracks their remediation.

> Synthetic proofs; devnet demo; no real KYC.

Plans: [`docs/plano-execucao.md`](docs/plano-execucao.md) (full) and [`docs/algoritmo-execucao.md`](docs/algoritmo-execucao.md) (simplified version).
Contract between teams: [`docs/interface-v2.md`](docs/interface-v2.md).

## Current status

| Part | Status |
|---|---|
| `programs/aveo-hook` | Policy, binding, extra metas and `execute`. `set_binding` checks the holder and the SAS attestation; `execute` rejects an unaccepted pair (`6005`) and a missing fact (`6012`). A signer that is not the issuer gets `UnauthorizedIssuer` (`6015`) |
| `packages/contracts` | Shared types and errors, including renewal of several mints in one transaction |
| `packages/sas-client` | SAS name truncated to 32 bytes, matching sas-lib and the hook |
| `packages/backend-aveo` | Renewal mints, incident rule and SQLite history for `scan:once` |
| `packages/backend-mpl` | Skeleton that returns `BackendNotIntegrated` (route A, until gate A) |
| `app/` | The Desk. Diagnosis, plan and verification run in the browser, on top of the RPC |
| `config/programs.json` | Fixed IDs for the hook, SAS and Token-2022. Demo mints come from `pnpm fixtures`, not from an invented manifest |

The program is **not deployed on devnet**. The ID `ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33` is fixed in `declare_id!` and in `Anchor.toml`. The matching keypair is not in Git. Do not run `anchor keys sync`, because it would change the ID. The local demo loads the compiled `.so` at that address.

### Compute units (localnet, Oct 2, 2026)

| Operation | Compute units |
|---|---|
| Token-2022 transfer with the hook (simulation, X → Y, 1 ALFA) | 73,596 |
| `set_binding` confirmed (Alfa and Beta) | 20,920–20,921 |
| `set_binding` simulated | 21,070–21,071 |

Two `set_binding` instructions fit in the same transaction within the limit. These numbers come from simulation/execution on the local validator and are not a promised ceiling.

## Prerequisites (tested versions)

| Tool | Version |
|---|---|
| Node | 22.x |
| pnpm | 10.x |
| Rust | stable (tested on 1.98) |
| Solana CLI (Agave) | 2.3.0 |
| Anchor CLI | 0.32.1 |
| Solana platform-tools | v1.53 |

### Installing the program (Linux / macOS, with Rust and Solana on your machine)

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Linux: system libraries required by Anchor
sudo apt-get install -y libudev-dev pkg-config libssl-dev

# Anchor CLI
cargo install --git https://github.com/solana-foundation/anchor --tag v0.32.1 anchor-cli --locked
```

### Windows

You do not need to install Rust or the Solana CLI. The Desk starts the validator and builds the hook inside a Docker container. The step-by-step guide is in [`app/README.md`](app/README.md) (section "Running against the local validator"). In short:

```bash
pnpm install
# in the app/ folder, with Docker running and AVEO_DEV_HOME pointing to a disk with ~5 GB free
pnpm solana:build
pnpm solana:validator
pnpm fixtures
pnpm dev
```

The first build downloads Agave 2.3.0 and the platform-tools. The repository is mounted read-only.

## Running

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev                # Desk at http://localhost:5173
pnpm fixtures           # local scenario (validator already running)
pnpm scenario -- status
pnpm scan:once          # incidents in app/.dev/incidents.sqlite
```

`pnpm build:program` (Linux/macOS, with the toolchain installed) uses `cargo build-sbf --tools-version v1.53` instead of `anchor build`, because the compiler bundled with Solana CLI 2.3.0 does not understand recent dependencies (edition 2024). On Windows, the equivalent is `pnpm --filter @aveo/app solana:build`.

Do not run `anchor keys sync`. The program ID is already in the code. The deploy keypair is not versioned, so there is no deploy to that address on devnet without it.

## Structure

```
programs/aveo-hook/     F1 Gatekeeper: policy, binding, hook
packages/contracts/     shared types and errors
packages/sas-client/    32-byte SAS name (issuance in app/scripts, via sas-lib)
packages/backend-aveo/  batch renewal, incident rule, SQLite
packages/backend-mpl/   not-integrated skeleton
app/                    Desk and the fixtures / scenario / scan:once scripts
config/                 program IDs, no invented mints (deploy manifests, no secrets)
docs/                   plans, interface, threat model
```
