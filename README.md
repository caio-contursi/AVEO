# Aveo Compliance Desk

**Understand why a wallet can move a tokenized asset, see which assets a proof affects,
and verify recovery when eligibility changes.**

Aveo is an operational desk for teams managing permissioned tokenized assets on
Solana. A reusable SAS attestation provides eligibility facts; each asset has its
own policy, enforced by a Token-2022 Transfer Hook rather than by the interface.

**[Open the devnet demo](https://aveoprotocol.io) ·
[Current status and evidence](docs/current-status.md) ·
[Security model](docs/security-operations.md)**

> Hackathon release candidate. Real devnet accounts and transactions, synthetic
> eligibility data, no real identity verification, no real-value assets.
> Real-wallet execution and full security/public-demo acceptance remain pending.
> This is not an independently audited production release.

## Try it without a wallet

1. Open [aveoprotocol.io](https://aveoprotocol.io) and select **EN** if needed.
2. Confirm the header says **devnet**. The slot shows the observed blockchain position.
3. Open **Wallets & assets** to compare Alfa and Beta across the demonstration wallets.
4. Select a wallet/asset cell to inspect its proof, policy and eligibility reason.
5. Open **Incidents**, **Receipts** and **Network** to understand remediation,
   recorded operations and the active deployment context.

Eligibility is a fresh observation, not a permanent permission. Proofs can expire;
an unavailable read is not zero balance or eligibility. Opening the site does not
sign or send. Empty incident/receipt history does not establish a completed demo.

## Try it with a wallet

Use a separate **Solana Devnet** test wallet, never a funded personal mainnet wallet.
Connecting it does not grant eligibility or tokens. The transfer form uses wallets
registered in the demonstration manifest: a new visitor cannot sign as those wallets.

The team must register and provision an approved external test wallet with test SOL,
tokens, a synthetic proof and bindings. Share only its public address, never a seed
or private key. Follow the [wallet acceptance checklist](docs/current-status.md#wallet-acceptance).
Public self-service onboarding is **not implemented**.

## Implemented versus verified

- Independent issuer policies, proof bindings and Token-2022 transfer enforcement.
- Browser diagnosis, preparation/simulation and wallet execution code.
- Proof-based incident grouping, renewal preparation and fresh-state verification.
- Durable pending-operation records and recovery that retain unknown outcomes.
- Public devnet deployment and a private-key-free HTTP/WebSocket RPC intermediary.
- English/Portuguese UI, automated tests and real read-only desktop/mobile browser evidence.

Implemented code is not completed acceptance: extension-wallet signing/rejection/
reload recovery, the full adversarial matrix and the public six-scene sequence remain
open. [Exact limits and release gates](docs/current-status.md).

## Architecture

```text
Desk (React / TypeScript) ── request signature ──> user's test wallet
          │
          └── HTTPS RPC intermediary (private Helius credential)
                         │
                         v
                    Solana devnet
             SAS proofs + Aveo policy/bindings
                         │
             Token-2022 transfer → Aveo Transfer Hook
```

The browser performs diagnosis, planning and verification using shared clients.
The intermediary transports requests; it holds no wallet signing keys and does not
decide eligibility. SAS is the Solana Attestation Service. A Transfer Hook is a
program Token-2022 invokes during a transfer to apply additional checks.

**MPL-3643 is not integrated or validated.** Its alternative backend is a disabled
skeleton, not evidence of protocol compatibility.

## Install and verify

Prerequisites: **Node.js 22** and **pnpm 10.33.3**. From a fresh checkout:

```bash
git clone https://github.com/caio-contursi/AVEO.git
cd AVEO
pnpm install --frozen-lockfile
pnpm verify
```

Verification runs RPC tests, TypeScript checks, lint, application/backend tests and
the frontend build, stopping on failure. It does **not** deploy or execute the full
blockchain acceptance suite. Existing SQLite experimental and Zod/Rollup warnings
are documented; exit code zero indicates success. Reproduction from a clean clone
of the final submitted candidate remains an open acceptance gate.

## Isolated local demonstration

Docker is additionally required. From the repository root:

```bash
pnpm --filter @aveo/app solana:build
pnpm --filter @aveo/app solana:validator
pnpm fixtures
pnpm dev
```

Open `http://localhost:5173`. This creates a **localnet** scenario, not public devnet
accounts. Local signing requires explicitly enabled synthetic development wallets;
see [local setup](app/README.md) and [guarded acceptance](docs/localnet-acceptance.md).
Starting the validator resets its dedicated ledger: do not run it in a shared
evaluation environment. Never point local fixture/scenario commands at devnet.
First-time downloads/builds require substantial time and disk space.

## Deployment and repository map

Devnet program: `28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS`
([Explorer](https://explorer.solana.com/address/28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS?cluster=devnet)).
Its identity differs from default localnet builds. Do not run `anchor keys sync`
or redeploy the program just to update the website.

| Path | Purpose |
| --- | --- |
| `programs/aveo-hook/` | Rust/Anchor policy, proof binding and transfer enforcement |
| `app/` | Desk UI, Solana clients, demonstration and acceptance scripts |
| `packages/contracts/` | Shared operation types and errors |
| `packages/backend-aveo/` | Backend helpers, incident rules and SQLite history |
| `packages/sas-client/` | SAS client/naming utilities |
| `packages/backend-mpl/` | Not-integrated alternative backend |
| `config/deployment.devnet.json` | Public scenario addresses; no keys |
| `ops/rpc-proxy/` | Bounded RPC intermediary and resource tests |
| `Dockerfile.web`, `compose.web.yaml`, `nginx.web.conf` | VPS deployment |
| `docs/` | Current status, security model, evidence and history |

Hosting requires private operator configuration; viewing the demo and running unit
tests do not. See [RPC deployment and rollback](docs/helius-rpc.md).
There is no hosted CI workflow or versioned license yet. Licensing requires owner
approval; public source availability alone is not an open-source license.

## Delivery material

Use [current status](docs/current-status.md) for release claims,
[the historical local walkthrough](docs/judge-walkthrough.md) for local evidence,
and [public release gates](docs/public-demo-release.md) for devnet signoff.
Do not present historical local evidence as current public execution.
[Portuguese development history](docs/development-history.pt.md) is preserved for
traceability, not as the first-use guide. Presentation/video and licensing remain
unfinished. No customer adoption, independent audit or commercial validation is claimed.
