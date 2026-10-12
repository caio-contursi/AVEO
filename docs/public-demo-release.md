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

## VPS public-release preparation, 2026-10-12

The hosting configuration now requires an explicitly selected public manifest
and runs `pnpm build:public`, replacing the ordinary-build gap above. Compose
passes the manifest as a required BuildKit build-only secret mount; this does
not mean its contents are private. The validated public JSON is intentionally
emitted into the frontend, while wallet keys and private run journals must never
be selected. The final image receives only the generated application and Nginx
configuration, not the manifest mount or source directory.

The Docker build pins the approved devnet program ID, official HTTPS devnet RPC,
confirmed commitment, implemented backend and disabled synthetic browser wallets.
It fails without the manifest and rejects malformed or mismatching manifests
through the existing public-release gate. A passed build is not proof that the
program or accounts exist; run the real-network preflight first.

Nginx now supports application deep links while `/deployment.json` remains an
exact JSON route with no-store caching and a 404 when absent, never an HTML
fallback. Private devnet wallet/run JSONL files are excluded from the Docker
context as well as Git.

After funding, deployment, fixture readback and public-manifest validation:

```sh
export AVEO_PUBLIC_MANIFEST=/absolute/path/public-deployment.json
pnpm devnet:preflight --manifest "$AVEO_PUBLIC_MANIFEST" --rpc https://api.devnet.solana.com
docker compose -p aveo-bruno -f compose.web.yaml config --quiet
docker compose -p aveo-bruno -f compose.web.yaml build aveo-web
```

Review the resulting image and release evidence before replacing the running
container. The build command does not publish it. Container replacement and
browser acceptance remain later steps; no running public service was changed.

Compose rejects a missing manifest variable and passes syntax validation with an
explicit path. This syntax check alone does not validate the file's contents.
`nginx -t` passed in an isolated network-disabled container using the existing
image and the revised configuration. The image was not rebuilt with a real
devnet manifest, because deployment and fixtures are still unavailable.

`pnpm verify` passed after this change: 2,622 app/script tests (including six new
hosting-contract checks), 41 backend tests, type checks, lint and ordinary build.
Existing SQLite and Zod/Rollup warnings remain unchanged. At confirmed slot
510300979 (`2026-10-12T14:56:39.537Z`), the deployment payer still had zero lamports.
Real public-image construction, hosted-origin RPC/CORS, wallet interaction and
the six scenes remain unverified. RELEASE-02 proposes container/manifest
provenance and hosted-origin smoke checks; it is backlog, not release evidence.

## Real devnet deployment, 2026-10-12

The dedicated payer received 20 devnet SOL through the external faucet. Funding
was verified on-chain, not inferred from the website's success message.

The approved program is deployed at
`28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS`, deployment slot 510305702.
Deployment signature:
`3KujHsrovdjqqgXKWadF3DZi7DQNuQpWGuWPFMeKzjjxfdevHqpFQ6ytS8Ui2YU3b7JHsacNSUeKQuKH7sTiPWAo`.
It was finalized with no transaction error. At observation slot 510305877, the
program was executable under the upgradeable loader and its ProgramData account
was `BbKJMwXkLa3VDxS2sEHRNmLQ5tHY24yViaAAv1d8FZ5F`. The full 357,872-byte
on-chain ELF matched the approved binary exactly, SHA-256
`45986a72db443a84d03ce0fa6f6b86ecf2680f924c6983cc85b7686ad52e5aec`.
Upgrade authority is the dedicated synthetic payer
`Bn9NpxkkHi9x9VNBaMXhHc5CgeKZrktsWPxKxXAt4R8Y`, not a revoked authority or
production governance mechanism. Secure long-term custody remains a human task.

RPC-based writes first failed after partially filling the explicit temporary
buffer. Read-only inspection verified its loader owner, authority and incomplete
bytes before resuming. RPC rate limiting also occurred. The successful resume
used Solana CLI's existing QUIC transport, the same devnet network, binary,
program identity and buffer. No alternate RPC provider, dependency or token
standard was introduced. Buffer recovery artifacts remain private outside Git.

Commit `c199d57` adds explicit `--external-issuer-funding`: the generator creates
a fresh synthetic issuer, exposes only its public address and waits at most
60 seconds for a fresh confirmed balance of at least 1 devnet SOL. Funding is
performed separately from the dedicated deployment payer. This mode requests
no faucet and loads no external/private payer key into the runtime. The default
faucet mode is unchanged. The observation proves available balance, not the
identity of a donor or a fabricated transfer signature.

The first private fixture run stopped after a submitted funding transfer could
not immediately be verified. Its original signature
`85mSe2RC8DNYENd6rxeocv2U7ZJ55JEd3QfxTtBCu1TwiwdgBtauFNBy9ftMjQcjnmkM6jCGkMutomWnMCKeXRR`
was later verified read-only at slot 510306052 against exact message fingerprint
`ae21fba386c79c87db13b6d25ef848b21b877c53ec340ce6639826a9a4c75b66`, with no resend.
That stopped directory is retained and is not a public manifest or accepted
scenario. The runtime now retries only bounded exact-message verification reads
when transaction data is unavailable; it still broadcasts once and stops if
verification cannot be established. A new regression covers delayed indexing.

Deployment is now verified. Fixture completion, public image publication,
extension-wallet acceptance and the six-scene walkthrough remain separate gates.

### Bootstrap transport hardening

Subsequent private runs also stopped before broadcast during simulation; they
did not produce a manifest and remain retained separately. An independently
prepared read-only simulation of the same funding transfer returned no error,
but this does not establish the precise cause of the earlier failed observation.
Do not describe a null history response as proof that a signed operation can be
resent. No stopped run was resumed or promoted to accepted.

The runtime retries only classified transient read failures (HTTP 429, 502,
503, 504 and an RPC minimum-context-slot-not-reached error). Semantic and unknown
RPC errors stop immediately; actual simulation and confirmed transaction errors
still reject the operation. A reviewer identified overly broad rejection retry
in the first helper; this was corrected with explicit classification and a
regression proving a semantic rejection cannot turn into a later success.
Latest-blockhash and simulation reads now carry minimum context slots derived
from the last confirmed operation or external funding observation. Private
journals record a sanitized simulation rejection category, never raw provider
credentials or transaction logs. None of these read retries repeats a broadcast.

The existing Compose project is `aveo-bruno`. Publication must explicitly use
`docker compose -p aveo-bruno -f compose.web.yaml`; the folder-name default would
create another project and collide with the current listener rather than update
the intended service. Preserve the old image for rollback before replacement.

### Nonstandard RPC rate-limit normalization

The official RPC was observed returning JSON-RPC error code 429. The installed
SDK's error formatter throws a TypeError for this unrecognized code in development
mode; an offline reproduction demonstrated that behavior. A narrow transport
wrapper now converts only numeric 429/429n responses into the SDK's supported
HTTP-rate-limit error before decoding, without retaining arbitrary server text.
Successful responses and semantic errors are passed through unchanged. Endpoint
pinning remains exact; no SDK upgrade or alternative provider was introduced.
Genesis reads now use the same classified, bounded read retry, but the returned
genesis must still match devnet exactly. Tests cover actual mocked HTTP response
decoding, success, semantic errors and a transient genesis failure followed by
correct identity verification. Four interrupted fixture directories remain
private and unaccepted; no public manifest was emitted from them.

An additional run stopped after RPC acknowledgement while the status query was
unavailable. Read-only inspection subsequently found that exact original
signature finalized without error; the signature was not resent. The runtime
now has a bounded, read-only reconciliation path only after matching submission
acknowledgement. It requires the original signature, exact message fingerprint,
successful transaction metadata and a fresh matching genesis. Observed on-chain
failure or wrong genesis permanently prevents that reconciliation. Missing
acknowledgement still stops; neither a balance nor a new unrelated signature
can clear the gate. Interrupted directories remain retained, not restarted.

The review also identified processed-status errors and unsupported transaction
metadata errors being lost before reconciliation, then a late-response observer
race. These were corrected: all observed status errors latch a stop; unsupported
metadata errors conservatively block continuation; individual request aborts and
an observer-closed flag prevent stale responses mutating settled records. Both
success paths recheck failure/network latches after the final genesis read.
Regressions include late lookup responses during final pin and after completion.
The scoped reviewer reported no remaining critical/high finding after these
fixes. This agent review is not an independent audit.

Final workspace verification for this increment passed 2,647 app/script tests,
41 backend tests, type checks, lint and ordinary production build. Existing
SQLite experimental and Zod/Rollup warnings remain unchanged. Real devnet
fixture completion/publication evidence is recorded separately from these
offline regression results.

The reviewed runtime also bounds classified retries for an explicit allowlist of
RPC reads used by rent queries, account resolution and final accounting. Request
abort signals are combined with the transport deadline. `sendTransaction`,
`requestAirdrop` and unknown methods are never retried by this transport. Tests
exercise actual mocked HTTP requests and assert one request for each mutating
method even when the endpoint returns its nonstandard 429 response.

The sixth scenario confirmed 30 operations, including issuance, mint/policy setup,
bindings and the first Alfa transfer, before an account-resolution read prevented
the next transfer from being prepared. No pending transfer was submitted at that
point, and no manifest was published. A later read-only Beta instruction preparation
passed with 15 accounts and zero signing/broadcast calls. This is evidence of a
partial scenario, not final accounting acceptance.
