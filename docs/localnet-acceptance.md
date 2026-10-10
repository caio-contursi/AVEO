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

### Recovery in an independent process

With the same loopback endpoints and explicitly pinned local genesis, run:

```sh
pnpm local:recovery:resume /absolute/temporary/artifacts/local-recovery-<uuid>.json
```

The manifest must be `deployment.json` beside that receipt. The command does not
import the fixture/key loader, require `wallets.json`, sign or submit. It reads
only bounded regular public files with approved filenames, rejects symlinks and
unknown receipt fields, and writes a separate public result without overwriting
the original. The first RPC request pins genesis; subsequent requests read the
full transaction and its confirmed/finalized signature status at the same slot.

Acceptance checks the raw Token-2022 TransferChecked instruction, associated token
accounts, manifest mint, source authority, single required signature, amount one,
decimals, the corresponding Aveo hook invocation and successful ledger metadata.
Historical pre/post token amounts must match both the saved receipt and exact
one-unit deltas. Current balances are not evidence of an old transaction. Raw
instruction decoding deliberately avoids `jsonParsed`: on the observed validator,
transfer-hook extra accounts were described as multisig signers despite a normal
single-signature transaction. Version-zero loaded addresses are resolved in
writable-then-readonly order.

This is intentionally a verifier for this synthetic one-transfer experiment, not
a general transaction verifier or a new wallet adapter. It trusts the approved
local RPC's ledger responses; it is not an independent cryptographic ledger proof.
Missing/pruned history, unavailable reads, failed transactions and inconsistent
evidence produce a nonzero exit and no PASS result. That exit does not establish
that the original transaction failed. Resume records zero signing/submission
calls for its own process; it cannot prove the original sender's attempt count.

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

A subsequent isolated increment submitted one new synthetic recovery transfer:
signature `5heKi4ntrnSFZWvGA3LwuKhCoed7zzyGnm5DhS6RfRfiWdTwX8UEy96dFL28UHYkctY1uVESD6vBrSsXd3TGqcby`,
slot `2359`, X `51 -> 50`, treasury `907 -> 908`. After that sender process exited,
`local:recovery:resume` independently verified the historical transaction with
zero signing/submission calls. Evidence:
`acceptance-rerun/local-recovery-resumed-df182f9e-6e14-4710-b07d-a886e4c02616.json`.
The increment adds 39 mocked verifier/boundary tests; those tests are not relabeled
as 39 live ledger scenarios.
`pnpm verify` passed after this increment: 1,800 app/script tests, 41 backend
tests, workspace/test types, lint and the application build. The pre-existing
SQLite experimental and Zod/Rollup annotation warnings remain. No Rust source or
program interface changed, and Rust tests were not rerun for this script-only
increment. A specialist's read-only review found no blocking issue in the stated
single-transfer scope; that review is not a security audit.

An attempt to recover the previous slot-959 receipt after restarting the validator
returned no transaction history and correctly did not pass. Persisting a receipt
does not guarantee that a disposable validator retains historical RPC metadata.
Configure and verify history retention separately before claiming recovery across
a validator restart. The independent-process success above does not claim that.

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
test. UI metadata/history alone do not cryptographically bind a signature to a
reviewed operation; the new CLI verifies the narrower saved synthetic transfer
against the approved RPC's actual transaction. The security matrix remains
broader than one successful acceptance run.

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
