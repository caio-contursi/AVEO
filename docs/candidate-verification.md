# Candidate verification — 2026-10-10

## Increment

The [candidate plan](audit-candidate-plan.md) starts with a source-grounded
threat model, operations runbook, shared immutable acceptance-stage contract and
two fail-closed SAS parser checks. No account layout, instruction interface,
program ID, dependency or attestation protocol changed.

Implementation commits: `442ac92` (SAS hardening) and `f08d1a1` (shared stage
manifest). The tested/build source matches these committed changes; evidence
documentation is committed separately.

The parser now rejects pause bytes other than 0/1 and checks signer count against
remaining account bytes before reserving memory. These are malformed-data
hardening changes, not evidence of a demonstrated exploit against SAS-owned
accounts. The tests cover all 256 pause bytes, truncated signer vectors, an
extreme count and valid empty signer vectors.

## Checks actually executed

- `pnpm verify`: PASS, 1,877 application/script tests and 41 backend tests,
  workspace/test types, lint and frontend production build.
- `cargo test --locked --offline`: PASS, 25 Rust tests in a network-disabled
  container with repository mounted read-only and isolated existing cache.
- Relative links in the three new plan/security documents: PASS.
- `git diff --check`: PASS.
- Fresh SBF compilation: PASS, Agave 2.3.0 / platform-tools v1.53 /
  SBF Rust `1.89.0-dev`; command below. Source snapshot matches current program
  directory. This is a fresh compilation, not clean-clone or independent
  reproducible-build certification.

```sh
cargo build-sbf --tools-version v1.53 --sbf-out-dir /opt/candidate/out -- --locked
```

Compilation used a temporary source copy at `/tmp/aveo-audit-build-pOmNSU`, not
repository build output. The first container-network download timed out; the
retry with host networking downloaded existing approved toolchain components
and succeeded. No new application dependency was installed. Host networking
was for tool downloads, not for the local validator.

Candidate binary SHA-256:
`3e5cddaab12eec4c12c71115cba13d96e61f927543505095c3bc3e4fc0b0c3ab`.
Cargo.lock SHA-256:
`59cca30cb61e609a354d1b1c0e1de12043b74c67f9908d260a96aeb59ebd87b8`.
pnpm-lock.yaml SHA-256:
`96acc00d4e676ace2078d8732a7829813f65d7b72e015cade1e65f80b2e65c2e`.
Node `22.23.3`; pnpm `10.33.3`.

## New isolated validator

The new candidate runs on Docker network `aveo-candidate-local-mMTxCx`, verified
`Internal=true`, with no published ports. A loopback-only TCP proxy exposes RPC
19899 and WebSocket 19900. Its ledger is separate from previous experiments.
No personal wallet, public-network transaction, real asset or previous fixture
was used. SAS and Token-2022 binaries reuse the earlier experiment's mounted
references; this does not independently audit those dependencies.

Observed genesis: `G6n5zJA5XhwnkxAteU8k56YV2BNNQ1bhHvk62GszivWM`.
At confirmed slot 150 the Aveo program was executable under the upgradeable
loader. ProgramData address:
`WxQo8HNT1XK5M6SKWpwgeHJENGZb528KFVFcnoV9dLv`.
Its ELF bytes matched the candidate binary hash (remaining allocated padding
was zero). The observed upgrade-authority field was
`11111111111111111111111111111111`, not null. This is local validator preload
state, not a public custody/governance claim. Hashing the program pointer account
itself did not match the ELF; the correct comparison reads its ProgramData.

The maintained cycle uses fresh synthetic fixtures with that exact genesis pin:

```sh
AVEO_CLUSTER=localnet \
AVEO_RPC_URL=http://127.0.0.1:19899 \
AVEO_WS_URL=ws://127.0.0.1:19900 \
AVEO_LOCAL_GENESIS_HASH=G6n5zJA5XhwnkxAteU8k56YV2BNNQ1bhHvk62GszivWM \
pnpm local:cycle
```

Cycle result: **PASS** for all four orchestration stages and **42/42 live
acceptance stages** on the freshly compiled binary. Evidence is temporary/local,
not an explorer URL or durable public release:

- `/tmp/aveo-local-cycle-gbLFUE/local-cycle-report.json`
- `/tmp/aveo-local-cycle-gbLFUE/acceptance-report.json`
- `local-recovery-2a50edf0-31e9-42e9-a4ca-14bd8414d725.json`
- `local-recovery-resumed-be5c8383-e904-4dec-8baa-3ecd05e166e2.json`

Recovery signed/submitted once; the independent read-only process passed after
the live scenarios without signing or resending. Original transfer signature:
`47ajRCKAxdSDDx45rQ8kGQGmLNDinPgsfbZdc1GLVr63bfBbeBA6R5b8w1ypAmQc2sV49yLnsZ22saaFSPM68PPF`.
The matrix remains **NOT_FULL**: T04, T05, T10, T14 and T17 are still NOT_RUN
for full-case acceptance. Passing 42 stages must not be described as 17/17
security-matrix acceptance or audit completion.

## Reviewer objections

Existing Zod/Rollup annotation and experimental SQLite warnings remain; no new
build warnings were observed. Repository-wide `cargo fmt --all -- --check`
does not pass: it reports existing formatting deviations including untouched
program files. They were not silently reformatted as part of this security patch.
Formatter installation initially stalled on container networking; the host-network
retry supplied the component and the check then ran.

Full security matrix, real extension-wallet acceptance, clean-clone reproduction,
public deployment, authority governance, independent audit and external pilot
are not completed by unit tests or this runbook. Mutable hook authority and
transfer-only (not burn) enforcement remain explicit product boundaries.
No new browser acceptance was performed for this increment; earlier browser
evidence belongs to its earlier binary/configuration.
