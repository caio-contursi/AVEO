# Judge walkthrough: six scenes with local ledger evidence

## What the evaluator sees

The default Desk destination is `/#/demonstracao`. It explains the problem,
shows six numbered scenes, links to the operational screens, and separates saved
runner observations from transaction outcomes checked against the configured RPC.
Opening the page never signs, submits, replays scenarios or requests synthetic
wallet keys. The explicit verification button is read-only and needs no wallet.

| Scene | What to look for | Source stages |
| --- | --- | --- |
| Reuse | One recorded SAS proof serves Alfa and Beta; permitted transfers have ledger receipts | `shared-proof-X`, `successful-transfers` |
| Independent policies | An accepted transfer and policy-specific rejections, with unchanged balances | `policy-differences-Y-B-Z` |
| Outside the Desk | An independently built Token-2022 transfer succeeds; a later expired-proof transfer is rejected | `external-with-extra-accounts`, `external-expired-proof-rejected` |
| Invalidation | An authorized SAS proof closure is followed by rejected transfers | `close-X-proofs`, `rejected-transfers-unchanged-balances` |
| Grouped impact | The same closed proof affects both assets in one recorded incident | `scan-grouping` |
| Renewal | New proof, wallet-signed batched binding update, fresh eligibility readback and permitted transfers | `issue-renewal-proof`, `signed-batched-rebind`, `fresh-readback`, `renewed-successful-transfers` |

The closure/grouping/renewal sequence is distinct from the later expiry check.
Do not narrate these as one contiguous expiry-and-renewal recording. The page
explains the distinction. The grouped incident is historical; after the local
cycle restores eligibility, the current incident scan need not recreate it.

An outcome labelled verified refers to a historical transaction read from the
pinned local ledger, not current eligibility, independently certified KYC,
historical proof-account authenticity or a completed security audit. The original
runner establishes the account/diagnostic observations. Current eligibility must
be checked separately in Wallets & assets. Localnet has no public explorer proof.

## Operator setup

Prerequisites: Node 22+, the locked workspace dependencies, and an approved
isolated local validator with the current Aveo, SAS and Token-2022 binaries.
Follow [localnet acceptance](localnet-acceptance.md) for isolation and genesis
pinning. Do not point local fixture scripts at devnet/mainnet. Do not use personal
keys. The expanded cycle needs historical transaction retention as described in
[matrix progress](security-matrix-progress.md).

From the repository root, export the actual approved loopback endpoints/genesis.
Values below are placeholders, not a deployment or approved public network:

```sh
export AVEO_RPC_URL=http://127.0.0.1:19899
export AVEO_WS_URL=ws://127.0.0.1:19900
export AVEO_LOCAL_GENESIS_HASH='<actual-approved-local-genesis>'
export AVEO_CLUSTER=localnet
pnpm local:cycle

# Copy the NEW private directory printed by local:cycle; do not reuse old fixtures.
export AVEO_DEV_DIR='<absolute-directory-from-the-passing-cycle>'
pnpm demo:evidence

VITE_CLUSTER=localnet \
VITE_RPC_URL="$AVEO_RPC_URL" \
VITE_COMMITMENT=confirmed \
VITE_DEPLOYMENT_URL=/dev/deployment.json \
VITE_ENABLE_DEV_WALLETS=false \
pnpm --filter @aveo/app exec vite --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173/#/demonstracao`. Select English or Portuguese. Review
the six cards, expand the evidence, then explicitly verify the transactions.
This page is an evidence-guided walkthrough, not an automatic transaction player.
For interactive signing, use separately approved disposable synthetic wallets
and the existing operational flow; verification alone does not replay renewal.

`demo:evidence` reads only bounded public artifacts after pinning genesis. It
requires the report's original observed genesis and deployment timestamp to match
the current context. Older reports without that run identity must be regenerated,
not assigned the current genesis. It requires the entire acceptance-stage manifest to pass, projects a fixed
set of public fields, validates the six-scene contract against the manifest, and
creates `judge-evidence.json` with mode 600. It refuses to replace an existing
file. Use a new cycle directory to regenerate evidence after changes.

The development server serves the evidence with no-store and revalidates it
before returning bytes. The public deployment endpoint also uses bounded regular
file reads, refuses symlinks and secret-like fields, and projects only known public
manifest fields. Unknown evidence fields and a renamed wallet file are rejected;
the evidence endpoint is disabled outside localnet. Synthetic wallets remain
disabled in this viewer setup. These development endpoints are not bundled into
production assets.

## Failure and review checklist

- Before explicit verification, receipts must remain recorded/unverified.
- Missing or mismatched evidence must keep the guide available without a green
  outcome. Never relabel another deployment's report as this run.
- Wrong genesis, pruned history, unavailable reads and altered ledger outcomes
  must not verify. Retry means another read, never another send.
- Network identity mismatch is displayed as divergent context, not a generic
  history outage. A readback's signature reference stays neutral even after the
  rebind transaction verifies; it is not confirmation of historical eligibility.
- Refresh/reload must not reuse a prior result as current verification or
  silently perform verification. Browser and CLI mutations must not run together.
- Test English/Portuguese, keyboard access, desktop and narrow mobile viewports.
  Viewport emulation is not physical-device or extension-wallet acceptance.
- Maintain the original failed reports. A corrected run is new evidence, not a
  retroactive rewrite of a failed run.

## Public release boundary

This implementation does not deploy, host or certify MPL-3643 interoperability.
Devnet/public-hosting authorization, an approved signing path, a browser-safe RPC,
the matching deployed program and actual extension-wallet acceptance remain
separate gates in [public demo release](public-demo-release.md). Do not publish
the local packet as evidence of public devnet execution or expose local wallet
files to jurors.

## Observed acceptance, 2026-10-10

The final guarded local cycle passed in `/tmp/aveo-local-cycle-qnQVIH`:
53 live stages, independent recovery, and seven controlled HTTP fault stages.
Its first acceptance stage records the actual observed genesis
`G6n5zJA5XhwnkxAteU8k56YV2BNNQ1bhHvk62GszivWM` and the deployment timestamp
`2026-10-10T19:36:27.209Z`. The exported packet was created successfully; a second
export failed with EEXIST and preserved the original bytes.

Real Chromium passed ten checks against that same deployment at
`http://127.0.0.1:5173`. All 19 unique transactions verified. The checks covered
default entry, explicit verification, rejection reasons, English/Portuguese,
desktop and 393/320 px viewports, keyboard access, neutral state after reload,
missing/malformed evidence, historical RPC unavailability, wrong genesis and
altered transaction slots. The negative transport/data scenarios used
controlled responses; the successful transaction checks used the real local RPC.
There were zero send attempts, zero private-wallet requests and zero page errors.
An HTTP read of `/dev/wallets.json` returned 404 with synthetic wallets disabled.

Screenshots and the browser report remain private temporary artifacts at
`/tmp/aveo-browser-review-kx6dEQ/judge-journey-1791661202524/`.
The initial browser harness failed a label assertion, not a ledger assertion;
that failed report was retained, then the harness used the shared translation
dictionary. The final run also verifies that historical readback references do
not receive a green transaction-outcome badge.

`pnpm verify` passed: 2,118 application/script tests in 80 files, 41 backend tests,
type checks, lint and the frontend build. A separate strict TypeScript check
covered the changed scripts and demonstration files. Existing SQLite experimental
and Zod/Rollup annotation warnings remain; no new build warning was introduced.
The on-chain Rust interface and binary were not changed or rebuilt in this round.

Reviewer objections about original run identity, manifest-file exposure,
ambiguous readback green states and network mismatch were corrected and retested.
Remaining limits: historical account/grouping observations, approved RPC trust,
incomplete full security matrix, no clean-clone acceptance for this increment,
no extension-wallet/physical-device/public-hosting acceptance, and no independent
audit or operator pilot. This is a verified local walkthrough, not public-release
or production sign-off.
