# Security matrix progress

## Acceptance policy

Passing a runner is not passing every security case. Live ledger results,
controlled transport faults and unit tests are recorded separately. The original
17-case matrix is not relaxed to produce a perfect score. Synthetic localnet is
the only approved transaction environment; no new protocol or program interface
is introduced by this increment.

## Workstreams and remaining objections

| Case | Evidence already available / current increment | Full-case gap |
| --- | --- | --- |
| T04 — missing binding/proof, false KYC | Live false-KYC rejection and closed-proof rejection already exist | Absent-binding scenario, including actual token rejection and unchanged balances |
| T05 — wrong subject/mint/domain | Live wrong-subject binding rejection already exists | Explicit wrong-domain and wrong-mint adversarial scenarios with ledger evidence |
| T10 — invalid account/layout/schema/signer | Current helper creates genuine SAS attestations with noncanonical Aveo boolean payloads and exercises signer revocation | False-owner/account substitution and incompatible-schema scenarios; SAS refuses truncated payload issuance before Aveo, so it cannot be counted as a malformed-proof hook test |
| T14 — RPC/confirmation interruption | Seven read-only HTTP transport-fault stages use actual local accounts and a real confirmed signature; included in the maintained cycle with zero-send evidence | Controlled faults are not uncontrolled provider-outage or extension-wallet evidence |
| T17 — inactive policy/paused schema/expiry boundary | Current helper adds schema pause/unpause, zero-expiry rebind rejection and strictly expired-proof rejection; inactive policy already exists | Exact expiry-equals-execution-Clock equality remains unit coverage, not live equality evidence |

Owners: security/SAS specialists implement T10/T17, orchestrator integrates and
reviews, Caio reviews scripts/backend boundaries, and Bruno owns program/product
acceptance. The helpers receive guarded callbacks: they do not acquire global
wallet loaders or their own submission authority.

`schema-validity-checks.ts` independently attempts restoration of schema status,
each original binding and temporary-proof cleanup even when one step fails.
It will not close a temporary proof still referenced by an unrestored binding.
`sas-adversarial-checks.ts` restores the original credential signer list and
compares protected account bytes and balances. Its auxiliary proofs remain in
the disposable ledger; they are not replacements for the original bindings.
Both stop without final PASS if restoration or evidence assertions fail.

Reviewer objections that remain explicit:

- Cleanup is best effort, not transactional: a killed process cannot execute
  `finally`, and an ambiguously confirmed mutation can settle after restoration.
  Discard the affected local fixtures after failure; do not reuse them as accepted.
- The SAS helper's accepted outbound/return transfers are separate transactions.
  A failed return is detected by final balance comparison but is not automatically
  compensated. No final PASS is emitted in that situation.
- Revoking the shared signer invalidates both endpoints; these tests do not
  independently isolate a destination-only signer failure.
- Enlarged local ledger retention is bounded. Missing historical transactions
  must remain a verification failure, never permission to resend.

## Maintained local cycle

The current stage manifest is version 2: the original 42 stages are followed by
seven schema/validity stages and four SAS adversarial stages. The report schema
remains version 1. `pnpm local:cycle` now runs five guarded child stages:

```text
fresh fixtures -> one-submission recovery -> 53 live stages
               -> independent read-only recovery -> 7 HTTP fault stages
```

Every stage is bounded, uses the selected private temporary artifacts, and stops
later stages after failure. The HTTP report is checked for exact stage ordering,
T14 PASS and retained zero-send evidence; child exit code alone cannot pass it.
The original demo report still marks T14 NOT_RUN because its own stages do not
exercise transport faults. T14's evidence belongs to `http-fault-report.json`,
not a retroactive rewrite of the demo report.

Set explicit loopback RPC/WebSocket URLs and the approved actual genesis hash
before running the cycle. Do not reuse an old fixture directory across validators
or mutate fixture balances concurrently. The fault command also requires an
explicit RPC/genesis pin and respects `AVEO_DEV_DIR`.

## Observed failures and retention correction

The first enlarged run failed when SAS refused a truncated payload during issuance.
That is not an Aveo hook rejection: the helper now issues only the supported
75-byte envelope with a noncanonical boolean value, which reaches Aveo validation.

A later run passed all 53 live stages but failed independent recovery because the
original transaction was no longer available. The pruning floor was slot 1,986.
The retained report remains failed; no signature was resent or receipt replaced.

The maintained validator now sets `--limit-ledger-size 1000000`. Agave 2.3.0
[CLI defaults](https://github.com/anza-xyz/agave/blob/v2.3.0/validator/src/cli.rs)
use 10,000 shreds; its
[test-validator RPC configuration](https://github.com/anza-xyz/agave/blob/v2.3.0/validator/src/bin/solana-test-validator.rs)
already enables transaction history and extended metadata. The issue observed
was retention, not an absent history-enable flag.

With enlarged retention, `/tmp/aveo-local-cycle-abWG8F/local-cycle-report.json`
passed all five maintained child stages: 53 live checks, independent recovery
and seven HTTP faults. After a restart preserving the ledger, another independent
read-only process verified the same original transaction at slot 2,622, including
historical balances 50/910 -> 49/911, zero signing calls and zero submission calls.
Its report is `local-recovery-resumed-772ca4cd-c54c-4951-8fb6-ca62c4095944.json`
in the same directory. A read attempted before restart readiness failed closed;
it was retried only after the actual genesis response became available.

These are private local evidence paths, not public explorer proofs. They contain
synthetic test results and do not establish an approved public release.

## Workspace verification

After the final rejected-binding slot-floor correction, `pnpm verify` passed
1,943 application/script tests in 77 files, 41 backend tests, production/test
type checks, lint and the frontend build. A separate strict TypeScript check
also covered the changed scripts and tests. The unchanged on-chain program's
25 Rust tests passed offline. Existing SQLite experimental notices and Zod/Rollup
annotation warnings remain; no new code warning was introduced.

Code increments: schema validity `ad79aa0`, SAS adversarial checks `de87898`,
maintained cycle integration `e947796`, and validator retention `f2f58c7`.
This is incremental workspace evidence, not clean-clone reproduction or a new
independent audit. The on-chain binary is the prior rebuilt candidate; these
changes do not alter its program interface or Rust source.

The final fresh-fixture rerun after that correction passed at
`/tmp/aveo-local-cycle-5mURhN/local-cycle-report.json`: five of five child stages,
53 of 53 live acceptance stages and seven of seven HTTP fault stages. Independent
recovery verified the original transaction without another submission. The
orchestrator still records `securityMatrix: NOT_FULL`; T04/T05/T10/T17 are not
promoted from partial evidence to full-case PASS.

## What would justify an internal 10

Internal sign-off requires a pinned, reproducible candidate with no hidden
blocking objections: complete adversarial matrix, fresh build/binary provenance,
one-submission recovery, verified administrative powers, clean-clone reproduction,
and real extension-wallet/public-demo acceptance. The presentation must explain
synthetic data, mutable authorities and protocol integration limits accurately.

A perfect jury score cannot be guaranteed. Independent audit, actual operator
participation and production custody/governance remain external gates in the
[candidate plan](audit-candidate-plan.md), not achievements of this test suite.
Unit assertions are not ledger proofs, and code-agent review is not an
independent audit. Current status is not an internal 10 while the gaps above
remain.
