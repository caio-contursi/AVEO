# Isolated localnet signing and recovery acceptance

## Scope

The owner explicitly authorized fresh synthetic wallets/tokens and signing,
submission and recovery tests on isolated localnet only. No personal wallet,
devnet/mainnet transaction or real asset is involved. This is not extension-wallet
acceptance, a production audit, a public deployment or evidence of operator adoption.

The experiment uses a new temporary artifact directory and ledger. The validator
runs on an internal Docker network with no external route; a loopback-only TCP
proxy exposes its RPC/WebSocket to the test tools. Other existing containers and
the repository's previous `.dev` wallets/reports were not used or overwritten.
Cached Aveo/SAS/Token-2022 binaries were mounted read-only, with no public-network
downloads in this round. No fresh SBF compilation is claimed.

Observed local genesis: `4nfcdrcw57kgy95FkeDLZ5aVcjMThnMpW1acN1gsmZyF`.
Aveo binary SHA-256:
`954de7bb17addb3ec9ef7401e44e402f476b93b1ba0872ff420c718f0f08a22a`.
The cached build copy of `programs/aveo-hook/src/lib.rs` and the current source
have the same SHA-256:
`3aa156edf59cb36c04a472a10bed076a8731f7b5c9b23233202e8c3b6c833fb0`.
Matching source files are provenance evidence, not a reproducible binary-build proof.

## Maintained safeguards and commands

`AVEO_DEV_DIR` selects an absolute, non-root artifact directory for fixture tools,
the acceptance report and development fixture serving. For isolated signing
acceptance it must be an existing temporary directory outside the repository,
containing the fresh deployment and synthetic wallets. The recovery CLI rejects
wallet-file symlinks and never falls back to the repository's `.dev` directory.

Shared local tooling rejects public/ambiguous endpoints. Fixture creation checks
validator identity before generating wallets; the shared `send` checks identity
before signing. `AVEO_LOCAL_GENESIS_HASH` pins the validator identity to the
approved experiment rather than trusting a loopback address alone. Public devnet,
testnet and mainnet genesis hashes are rejected. New private files are created
with mode `600` and their directory with mode `700`.

After separately starting and verifying an isolated validator, use its **actual**
fresh genesis and a new private directory. Do not copy a local manifest to another
ledger or reuse this observed genesis for a newly generated ledger.

```sh
AVEO_DEV_DIR=/absolute/private/temporary/artifacts \
AVEO_RPC_URL=http://127.0.0.1:18899 \
AVEO_WS_URL=ws://127.0.0.1:18900 \
AVEO_LOCAL_GENESIS_HASH=<verified-fresh-local-genesis> \
pnpm fixtures

# Use the same four variables for these commands, run sequentially:
pnpm local:recovery
pnpm demo:report
```

The environment assignments above apply only to the fixture command; export them
or repeat them for each later command. Never run browser and CLI balance-delta
checks concurrently on the same subjects. The live acceptance suite deliberately
mutates policies, bindings and proofs; this is why it uses disposable fixtures.

`pnpm local:recovery` captures the signature before the sole raw submission,
temporarily prevents confirmation reads, records `unknown`, then restores reads.
It requires confirmed hook success and fresh exact balance deltas. It does not
sign or send again during recovery. Its JSON evidence contains no private keys
or serialized transaction. The injected read fault does not fake ledger execution.
The report preserves pending/unknown evidence if a later stage fails.

## Evidence observed on 2026-10-10

- `pnpm verify` passed: 1,761 app/script tests, 41 backend tests, type checks,
  lint and the application production build. Existing Zod/Rollup annotation and
  Node experimental SQLite warnings remain; no new build warnings were observed.
- `cargo test --locked --offline` passed 23 Rust tests in a network-disabled
  container, using the existing toolchain/cache and read-only repository mount.
- Browser acceptance passed ten checks using Chromium 156 and the real local RPC.
  The UI signed/submitted one transfer, captured its public receipt with confirmation
  held, and reloaded before receiving confirmation. Rechecking at 1440 and 393 px
  required no connected signer and did not submit again. No page errors occurred.
- Browser transaction slot `855`, signature
  `3f9CzSyYcQ9zQ1pzQVn9nG98jzhnfmpp7Ud3FtbDT9KoEUw8hA6ABGh3y5uEdtfYJX9z7WKc5monzzdRCrBrfNTu`:
  Alfa X `50 -> 49`, treasury `910 -> 911`.
- CLI recovery passed with one signing and one submission, a deliberately
  unavailable confirmation read and subsequent real confirmation at slot `959`.
  Fresh balances at slot `961`: X `49 -> 48`, treasury `911 -> 912`.
  Signature:
  `3sNjnz4Xs81oY5ReTgHJ1CwcS53UqtMvRBm7YCV2EtmwVZxT92KAndUKj9mdToKTR55VwcDN6KapHjHMRoBX556Q`.

The first broader live acceptance attempt recorded 33 passing stages, one failure
and eight unexecuted stages. The loopback proxy process exited with SIGTERM (143),
and subsequent RPC requests returned `ECONNREFUSED` while the validator remained
running. The interruption also prevented the runner's cleanup transactions. Its
failed report and mutated disposable fixtures are preserved, not reclassified as
a pass. A second attempt uses newly generated wallets/assets in a separate
`acceptance-rerun` directory on the same isolated ledger.

The second live acceptance attempt passed **42/42 stages**, including actual
policy deactivation/restoration, clock-based expiry, rejected transfers with
unchanged balances, external Token-2022 transfers, delegated transfers, signed
batched renewal, fresh readback and incident persistence after process restart.
Its report is `acceptance-rerun/acceptance-report.json`. The complete security
matrix still marks T04, T05, T10, T14 and T17 as `NOT_RUN`: partial coverage in
these stages or in the separate recovery experiment is not full matrix acceptance.

Local evidence locations (temporary, not public URLs):

- `/tmp/aveo-local-acceptance-oNUscu/artifacts/`
- `/tmp/aveo-local-acceptance-oNUscu/acceptance-rerun/`
- `/tmp/aveo-browser-review-kx6dEQ/local-wallet-evidence-1791655595909/`

Private wallet bytes remain only in the temporary fixture directory and must
never be attached to a report or committed. Browser acceptance is an isolated
Playwright experiment, not yet a maintained CI browser suite.
After acceptance, the experiment's validator, loopback proxy and Vite server
were stopped. Ledgers, private fixtures and public reports/screens were preserved
in the temporary directories; the unrelated existing environment was not stopped.
These paths are local evidence, not durable public hosting or a released demo.

## Reviewer objections and follow-up proposals

Confirmed local execution closes the previous synthetic signing/recovery evidence
gap, not the public-demo gap. The browser uses the synthetic SDK adapter, not a
Phantom extension; 393 px is emulation, not a physical phone. Reload while reads
are held is not a hard browser-process crash, multi-tab signing or lost-storage
test. Metadata/history do not cryptographically bind a signature to a reviewed
operation. The security matrix remains broader than one successful acceptance run.

Screens were reviewed: prepared signing and recovered confirmation remain visible
without horizontal overflow. The mobile receipts view still contains substantial
explanatory text; English UI also displays Portuguese fixture labels. Those are
presentation objections, not hidden transaction failures.

- **LOCAL-01 (proposed):** maintain a reproducible isolated validator/browser runner
  and consolidate recovery receipts with the acceptance report, removing one-off
  proxy setup and temporary browser tooling. Preserve separate static failure
  codes for scenario and cleanup failures without exposing raw RPC errors.
- **LOCAL-02 (proposed):** repeat signing/recovery with an actual extension wallet
  and a physical mobile device, preserving the same no-resend evidence requirements.
