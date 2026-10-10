# Audit-candidate delivery plan

## Decision and scope

This plan supersedes the old execution schedule for security preparation, not
the approved stack or program interface. The immediate target is a reproducible
hackathon release candidate with explicit residual risks. An independently
audited production release is a separate gate, not a label earned by more tests.

Only synthetic signing on isolated localnet is currently authorized. Public
devnet fixture creation, deployment, hosting publication and mainnet are not
authorized by this plan. Bruno owns program/product decisions; Caio reviews
application, backend and script changes. No new framework, custody system or
attestation protocol is introduced.

MPL-3643 identity/policy interoperability remains an integration question:
the current SAS proof, issuer policy and Token-2022 hook are implemented, but
the MPL backend is not integrated. No compatibility certification is claimed.

## Starting evidence, not an audit verdict

- Maintained synthetic cycle: fixture creation, one-submission recovery,
  42 live acceptance stages and independent read-only transaction recovery.
- Latest recorded workspace verification: 1,863 application/script tests and
  41 backend tests, type checks, lint and frontend build. This is historical
  evidence; every candidate needs a fresh run after its final changes.
- Chromium acceptance used real local RPC with a synthetic wallet adapter;
  it does not establish Phantom/Solflare extension behavior or physical-device UX.
- Full security matrix still has T04, T05, T10, T14 and T17 NOT_RUN.
- No independent audit, external operator pilot or current public-release
  acceptance is established. See [local evidence](localnet-acceptance.md) and
  [public release prerequisites](public-demo-release.md).

The first execution increment is recorded in
[candidate verification](candidate-verification.md): rebuilt SBF, fresh isolated
42-stage regression and independent recovery passed; full matrix remains open.

The next execution increment is tracked in
[security matrix progress](security-matrix-progress.md); it adds guarded RPC
fault acceptance and partial SAS/schema adversarial scenarios without promoting
unexecuted subcases to full-case PASS.

## Parallel execution and ownership

| Workstream | Specialist / human reviewer | Deliverable | Objective gate |
| --- | --- | --- | --- |
| A — Security model | Security specialist; Bruno | Threat model, administrative powers, response runbook | Every privileged operation mapped to actual code, trust assumptions and residual risk |
| B — Acceptance integrity | TypeScript test specialist; Caio | Shared versioned stage manifest | Producer and consumer agree; missing, duplicate and unexpected stages cannot pass |
| C — Candidate integration | Orchestrator/reviewer; Bruno + Caio | Current plan, release evidence inventory, final verification | Exact commit, clean worktree, reproducible commands, honest PASS/FAIL/NOT_RUN |
| D — Remaining adversarial cases | On-chain/SAS specialist; Bruno | Full T04/T05/T10/T17 local-ledger fixtures and rejection evidence | Each subcase actually executed; confirmed rejection and unchanged balances where applicable |
| E — Failure reconciliation | Backend/QA specialist; Caio | T14 end-to-end interruption and recovery | No duplicate send; unavailable/inconsistent reads never resolve an incident |
| F — Public demo | Release specialist; Bruno deployment owner + hosting owner | Approved devnet release and six-scene recording | Hosted third party can reproduce with a real test extension wallet |
| G — Independent review | External auditor; Bruno | Scoped review and finding register | Auditor reviews pinned code/binary/configuration; blocking findings fixed and retested |
| H — Limited pilot | Product specialist; consenting external operator | Measured pilot using synthetic assets | Actual operator observations and permission to publish; no fabricated adoption |

Agents can implement and test A–E. They cannot themselves supply independent
audit, real operator participation, key custody or deployment permission.
Workstreams D/E must use disposable fixtures and sequential ledger mutations;
parallel agents must not mutate the same policies, wallets or balances.

## Ordered gates

### Gate 1 — Finish internal security acceptance

1. Map every outstanding matrix subcase to a fixture and assertion before coding.
   T04 includes absent proof/binding, not only false KYC; T05 includes domain and
   mint mismatch, not only subject mismatch. T10 includes malformed accounts,
   schema and signer failures. T17 includes paused schema and expiry boundaries,
   not only inactive policy. Never change NOT_RUN to PASS for partial coverage.
2. Execute failures against actual local ledger accounts where feasible; isolate
   controlled RPC faults from ledger scenarios in the report.
3. Test T14 through diagnosis, submission reconciliation and incident persistence.
4. Run `pnpm verify` and Rust tests, then freshly compile the deployable SBF binary
   with the pinned toolchain. Record source commit, lockfile/tool versions and
   binary hash. A matching cached source file is not a reproducible-build proof.
5. Reproduce from a clean clone without copying private artifacts. Record exact
   commands, durations, failures and remaining toolchain warnings.

**Stops release:** bypass, incorrect subject/provider authorization, fabricated
confirmation, duplicate submission, secret exposure or unexecuted required cases.

### Gate 2 — Administrative and operational sign-off

Review [threat model](threat-model.md) and [operations](security-operations.md).
Decide which issuer, SAS, transfer-hook and upgrade powers the demo intentionally
retains. Record actual authority addresses privately/publicly as appropriate,
with readback evidence. Do not silently revoke or rotate authority: irreversible
changes and custody arrangements require a human decision.

A policy `active=false` is not a global pause and cannot stop an authority from
replacing the hook. The release description must expose those boundaries. If
additional governance is required, propose it separately rather than replacing
the fixed stack in the final hackathon days.

### Gate 3 — Public hackathon candidate

Bruno supplies the deployment decision and authority; the hosting owner chooses
the destination. Implement a separately reviewed devnet signer path; local-only
guards must remain intact. Then follow [public-demo-release.md](public-demo-release.md).

Require all six scenes, real extension-wallet rejection, interrupted-operation
reconciliation, keyboard use and mobile viewport acceptance. Include public
transaction signatures/slots and synthetic-data notices. Publish no wallet keys
or credential-bearing RPC URLs. Refresh reports after the final change.

### Gate 4 — Audit-ready packet and independent review

Freeze a commit and include scope, account/instruction interface, threat model,
authority inventory, build provenance, full security matrix, regression commands,
known limitations and operational response procedures. Request an independent
review of the program plus SAS decoding, hook resolution and transaction/receipt
verification boundaries. A code-agent review is preparation, not independence.

Each finding has severity, owner, reproducer, patch commit and retest evidence.
No unresolved critical/high security finding may pass this gate. Bruno decides
budget, reviewer availability and acceptance of lower-severity residual risks.

### Gate 5 — Pilot and production decision

Run the existing [operator pilot protocol](operator-pilot.md) with a consenting
external operator. Start with synthetic assets, bounded participants and explicit
support/stop criteria. Production additionally needs custody, authority governance,
RPC/history retention, monitoring, backups and operational staffing decisions.
Mainnet or real assets require a new explicit approval and independent review.

## Time budget and deadline strategy

These are planning ranges in engineering hours, not delivery guarantees:

| Increment | Estimate | Main dependency |
| --- | --- | --- |
| Model, runbook, shared acceptance manifest and updated plan | 4–8 | Internal parallel engineering/review |
| Remaining matrix and T14 full-path tests | 12–24 | Fixture capability and adversarial failures found |
| Clean-clone reproduction, fresh SBF provenance and candidate review | 4–8 | Pinned toolchain/build access |
| Public deployment, extension-wallet acceptance and six scenes | 6–12 after prerequisites | Human authority, approved signing path, hosting and test wallet |
| Submission recording and coherent release docs | 3–6 | Passing candidate and verified competition requirements |
| Independent audit, remediation and operator pilot | Not reliably schedulable in hours | External availability, findings, consent and budget |

Parallel execution reduces elapsed time only for independent work. With the
competition imminent, prioritize gates 1–3 and an honest gate-4 packet. Do not
promise a completed independent audit before an auditor commits to a scope/date.
If public deployment remains unauthorized, ship verifiable local evidence and
state that limitation rather than pretending it is a public on-chain product.

## Completion rule

The orchestrator reviews evidence and objections, not a target score. A candidate
passes only the gates it demonstrably satisfies. Jury scoring, market adoption
and external audit cannot be guaranteed. Failed gates remain visible with an
owner and next action; no new cosmetic features compensate for missing evidence.
