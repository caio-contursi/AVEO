# Public devnet demonstration release

## Scope and ownership

Priority 1 is a public, reproducible demonstration, not a production audit.
The existing Anchor/SAS/Token-2022 architecture stays unchanged. This release
preparation touches Caio's scripts and application build; Bruno must approve
and perform the program deployment and review the public policy configuration.
It does not establish official MPL-3643 integration: the alternative backend
remains not integrated.

| Workstream | Deliverable | Acceptance owner |
| --- | --- | --- |
| Program deployment | Existing Aveo program deployed to devnet at the configured ID | Bruno, with deployment authority |
| Public fixtures | Real devnet mints, policies, SAS proofs, bindings and funded test subjects | Bruno and Caio; explicit signing authority |
| Release configuration | Valid public manifest, matching program ID, synthetic wallets disabled | Release engineer / orchestrator |
| Read-only preflight | Correct devnet genesis; Aveo, SAS and Token-2022 executable | Network verification specialist |
| Browser acceptance | Real wallet, rejection, renewal and interrupted-operation recovery | QA reviewer and test-wallet owner |
| Hosting | HTTPS URL, RPC supporting browser CORS and client-side routing | Hosting-account owner |

No secrets belong in a manifest, frontend environment, screenshot or evidence
report. Every `VITE_*` value is public. An RPC provider key hidden in a URL path
is still public even if a build accepts that URL: use a browser-safe endpoint.
Never publish `.dev/wallets.json`, private RPC credentials or deployment keypairs.

## Release preparation commands

These commands assume a **real devnet** manifest already exists at an explicitly
chosen path. They do not create accounts, deploy a program or sign transactions.
Do not relabel local fixtures as devnet; those accounts do not exist there.
Paths below are examples, not files shipped in this repository.

```sh
pnpm manifest:public --input /absolute/path/devnet-deployment.json --output /absolute/path/public-deployment.json
pnpm devnet:preflight --manifest /absolute/path/public-deployment.json --rpc https://api.devnet.solana.com

AVEO_PUBLIC_MANIFEST=/absolute/path/public-deployment.json \
VITE_CLUSTER=devnet \
VITE_RPC_URL=https://api.devnet.solana.com \
VITE_COMMITMENT=confirmed \
VITE_AVEO_PROGRAM_ID=ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33 \
VITE_BACKEND=aveo-sas-hook \
VITE_ENABLE_DEV_WALLETS=false \
VITE_DEPLOYMENT_URL=/deployment.json \
pnpm build:public
```

The public build emits `app/dist/deployment.json` using the validated public
manifest. Ordinary builds remain available for local development. A successful
build only proves configuration and bundling; the network preflight only proves
the checked programs exist and are executable on devnet. Neither proves that
the mints, bindings, proofs, wallet flow or business scenario work.

Before uploading `app/dist`, inspect the artifact for private files and confirm
its manifest matches the build configuration. Configure hosting to return
`index.html` for application routes, but serve `/deployment.json` as JSON, not
an HTML fallback. Avoid caching the manifest independently of the release.
Test RPC access from the actual hosted origin; a Node preflight cannot prove CORS.

## Six scenes required for sign-off

Record the release commit, URL, network, program ID, relevant public addresses,
transaction signatures and observation slots. Use an approved test wallet with
devnet SOL only. Never request a user's seed phrase.

| Scene | Required evidence | Failure that blocks sign-off |
| --- | --- | --- |
| One proof, two assets | Both bindings point to the same real SAS attestation; fresh eligibility observations | Two unrelated proofs presented as reuse |
| Independent policies | One subject accepted by one asset and rejected by another; correct reason visible | UI-only blocking or stale verdict |
| Transfer outside Desk | Independent Token-2022 transfer invokes the hook and respects policy | Bypass succeeds or only a simulated result exists |
| Proof expires | Validator time passes expiry; actual transfer rejected | Browser clock alone determines the result |
| Grouped impact | Desk groups affected assets by the same expired proof | Unrelated proofs grouped together or unreadable states |
| Signed renewal | Wallet signs the approved plan; confirmation and fresh reads prove recovery | Optimistic success, duplicate resend, or unchanged binding |

Also test wallet rejection, RPC interruption after submission, reload with an
unknown signature, keyboard navigation and a mobile viewport. Unknown outcomes
must stay unknown until reconciled; reloading must not silently resend a transfer.
An automated mock run is valuable regression evidence, not a substitute for
this real-network acceptance.

## Current external prerequisites

The configured program ID already exists in source. Public release still needs
deployment authority for that exact ID, devnet fixture-signing authority and an
approved hosting destination. If the original deployment key is unavailable,
the team must approve an identity/configuration change; do not silently invent
a new ID. Existing local fixture scripts are localnet tooling and must not be
pointed at devnet as an unreviewed shortcut.

## Proposed follow-up issues

- Automate the six-scene public evidence capture after the approved devnet
  signer workflow exists, preserving unknown transaction outcomes and avoiding retries.
- Add hosted-origin smoke checks for routing, manifest cache coherence and RPC
  CORS so a valid local artifact cannot be mistaken for a usable public release.

## Preparation review, 2026-10-10

- `pnpm verify` passed: type checks, lint, 1,691 app/script tests, four backend
  tests and the ordinary production build. The existing Zod/Rollup annotation
  warnings and experimental Node SQLite warning remain; this is not a warning-free toolchain.
- The preparation adds 166 tests: 80 manifest, 69 preflight and 17 public-build gates.
- A real Vite invocation with public-release mode and `VITE_CLUSTER=localnet`
  exited unsuccessfully before transforming application modules, as required.
- Read-only `getAccountInfo` at confirmed devnet slot `509619845` returned `null`
  for the configured Aveo program. This is a dated observation, not a permanent
  statement about the address.
- No deployment, wallet signature, transaction submission, hosting publication,
  real-network fixture creation or six-scene acceptance was performed in this round.

Reviewer objections remain explicit: executable program presence does not prove
binary identity or fixture correctness; manifest validation cannot detect every
secret disguised as an ordinary label; Node RPC checks cannot prove hosted-browser
CORS; and the wallet demonstration cannot pass while deployment is absent.
Public-demo sign-off is therefore still pending.
