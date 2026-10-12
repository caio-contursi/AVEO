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
VITE_AVEO_PROGRAM_ID=28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS \
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

The owner approved a dedicated devnet identity on October 11. Its program key
exists outside the repository; the original localnet identity stays unchanged.
Public release still needs test funding, deployment, devnet fixtures and hosted
browser acceptance. The owner has authorized synthetic devnet deployment and test
transactions; use dedicated test wallets, not the local fixture wallets or any
personal wallet. The intended public domain is `aveoprotocol.io`; publication
still needs the hosting configuration and a reviewed release artifact.
Existing local fixture scripts must not be pointed at devnet as a shortcut.

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

## Deployment-key check, 2026-10-10

The temporary SBF build generated a program keypair outside the repository.
Reading only its public address in a network-disabled container returned
`28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS`, which is **not** the configured
Aveo program ID. This artifact is not a deployment key for the configured ID.
No private key was printed, exported or committed. No program identity changed.
The owner must supply secure access to the matching program key, or explicitly
approve a new identity and coordinated configuration update.

## Approved devnet identity and bootstrap, 2026-10-11

This update supersedes the earlier deployment-key prerequisite. The owner
explicitly approved `28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS` as the
exclusive devnet program identity. The `devnet` Cargo feature selects that ID
at compile time; a default build retains the original localnet ID. Account
layouts and instruction interfaces are unchanged. New devnet accounts must be
derived from the new identity, never copied or relabeled from localnet.

The new `devnet:fixtures` command has a dedicated runtime. It verifies devnet's
genesis and the executable Aveo, SAS and Token-2022 accounts before creating
keys, requesting test funding or signing. Its first reviewed transport accepts
only the official devnet HTTP/WebSocket endpoints. It creates synthetic wallets
and accounts, simulates before sending, records the original signature durably,
does not automatically retry submissions and stops on ambiguous outcomes.
Private wallet/run snapshots are append-only JSONL files with restrictive
permissions and synchronized writes. These are not a supported crash-resume
interface: preserve an interrupted directory for inspection, do not rerun it.

The fixture generator creates two Token-2022 assets, distinct policies and
shared SAS proofs/bindings, initializes balances and checks fresh on-chain
accounting before writing a public `deployment.json`. Its 20-minute default
short-lived proof is intended for a rehearsed expiry scene, not a permanent
public scenario. Test funding for the fixture issuer is separate from program
deployment funding; its one-shot faucet request can also fail.

After deployment and readback, run from `app` with a newly created private
directory, outside the repository:

```sh
AVEO_DEVNET_FIXTURE_DIR=$(mktemp -d /tmp/aveo-devnet-fixtures-XXXXXX)
pnpm devnet:fixtures --execute-synthetic-devnet \
  --directory "$AVEO_DEVNET_FIXTURE_DIR" \
  --rpc https://api.devnet.solana.com \
  --ws wss://api.devnet.solana.com
```

Publish only the validated public manifest. Never publish `devnet-wallets.jsonl`,
`devnet-run.jsonl` or deployment keypairs. The public release commands above
remain a later step, not proof that the fixture command was executed.

### Build and network evidence

- `pnpm verify`: 2,616 app/script tests and 41 backend tests passed, plus type
  checks, lint and the ordinary production build. The new devnet modules account
  for 99 tests; their network scenarios use injected RPC, not a real deployment.
- Rust library suites: 26 tests passed with the default identity and 26 with
  `devnet`, using the cached offline toolchain. No new compiler warnings.
- Fresh SBF build used `cargo build-sbf --tools-version v1.53 --sbf-out-dir
  /opt/candidate/out -- --locked --offline --features devnet` in a network-disabled
  container. Artifact: `/tmp/aveo-devnet-build-hDcvXX/out/aveo_hook.so`, 357,872 bytes,
  SHA-256 `45986a72db443a84d03ce0fa6f6b86ecf2680f924c6983cc85b7686ad52e5aec`.
  The copied program source matches this working tree; there is no new release
  commit yet. Preserve the artifact and record its eventual deployment.
- Confirmed devnet observation at slot 510039489: the new Aveo program account
  was absent; SAS and Token-2022 were executable. This is a dated observation.
- Dedicated synthetic deployment payer:
  `Bn9NpxkkHi9x9VNBaMXhHc5CgeKZrktsWPxKxXAt4R8Y`.
  One 2-SOL faucet request returned no usable confirmation; no retry was made.
  A read at `2026-10-11T21:40:16.801Z`, slot 510040781, found balance zero and
  no recent signatures. Private funding evidence remains outside the repository.
- Rent estimates in lamports: program data 1,818,868,600; temporary buffer
  1,818,827,960; program account 833,120. Approximately 3.64 devnet SOL plus
  fees is needed at peak; 5 devnet SOL provides a preparation margin. These
  are test funds, not a request for mainnet SOL or a purchase.

### Reviewer objections and next actions

Funding is the current external blocker. After test funding, deploy this exact
binary with the approved program key, verify executable ownership and program
identity, then create fixtures and perform the six scenes. Do not use the
different keypair automatically generated in the fresh SBF output directory.
The approved program key and dedicated payer are private external artifacts;
their secure retention and upgrade-authority custody need a human owner.

No program deployment, real devnet fixture execution, extension-wallet browser
acceptance or hosting publication occurred in this increment. Passing bootstrap
tests does not complete the full adversarial security matrix or establish
independent audit, MPL-3643 integration or production readiness. The current
localnet viewer was not switched or reset.

## Consolidation into AVEO, 2026-10-12

The owner authorized consolidation and supplied repository-local commit
authorship. Readiness documentation and recovery/devnet changes were recorded
in focused commits and integrated into `/home/bruno/projetos/AVEO`, branch
`bruno`. This is now the active implementation directory; no additional
worktree was created. The existing readiness/recovery directories remain for
reference, not parallel implementation. No branch was pushed and no remote
GitHub or running public site was changed.

The five existing VPS hosting files were preserved byte-for-byte and recorded
in commit `fd9e9a4`. This preserves configuration; it does not approve it for
the public release. `Dockerfile.web` still runs the ordinary build and needs a
reviewed public-manifest/build configuration before publication. Compose syntax
validation passed, but no hosting image rebuild or container replacement ran.
Commit `df03e99` extends Git exclusions to deployment keypairs and private devnet
JSONL journals; actual `git check-ignore` checks passed.

After integration, `pnpm install --frozen-lockfile --offline` and `pnpm verify`
passed in AVEO: 2,616 app/script tests, 41 backend tests, type checks, lint and
ordinary production build. Existing SQLite experimental and Zod/Rollup annotation
warnings remain; there were no new warnings. No Rust source changed since the
previous successful default/devnet suites and SBF build; they were not rerun
in this consolidation increment.

The owner requested 5 devnet SOL through the faucet. Repeated read-only balance
checks still returned zero; at `2026-10-12T14:52:20.356Z`, confirmed slot 510299896,
the dedicated payer had zero lamports. A faucet request is not funding evidence.
If it supplied a signature, inspect that public transaction; otherwise obtain
its success/error message before assuming a pending transfer. No new airdrop,
deployment or fixture submission occurred during consolidation.

Reviewer objections remain: funding, real deployment/fixture readback, reviewed
public hosting configuration and real-wallet/six-scene acceptance are pending.
Consolidation is not devnet or public-demo sign-off. Suggested release-provenance
and interrupted-journal improvements remain in `docs/backlog.md` as RELEASE-01
and DEVNET-01; no new feature scope was added.
