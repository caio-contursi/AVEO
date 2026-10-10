# Audit-candidate delivery plan

## Decision and scope

This plan supersedes the old execution schedule for security preparation, not
the approved stack or program interface. The immediate target is a reproducible
hackathon release candidate with explicit residual risks. An independently
audited production release is a separate gate, not a label earned by more tests.

Synthetic signing on isolated localnet and deployment/test transactions on
devnet are authorized by the owner. Dedicated test wallets and test SOL only:
personal wallets, real assets and mainnet remain excluded. Program-key access
and the approved hosting destination remain prerequisites, not permissions
supplied by this document. An external audit still needs a named reviewer,
scope and approved budget before any financial commitment. Bruno owns
program/product decisions; Caio reviews
application, backend and script changes. No new framework, custody system or
attestation protocol is introduced.

MPL-3643 identity/policy interoperability remains an integration question:
the current SAS proof, issuer policy and Token-2022 hook are implemented, but
the MPL backend is not integrated. No compatibility certification is claimed.

## Six mandatory hackathon acceptance conditions

All six conditions are required for release sign-off. A passing unit suite,
local ledger runner or build cannot substitute for a public-network/wallet
condition. Keep failed and unexecuted conditions visible; never lower the
criteria to obtain a desired score.

| Condition | Required evidence | Current blocker / owner |
| --- | --- | --- |
| Current evidence | Verify final source commit; fresh app and Rust tests, build and blockchain acceptance; identify binary and fixture provenance | Orchestrator integrates final changes and reruns; historical reports are not final-release evidence |
| Complete mandatory security | All T04/T05/T10/T17 subcases plus regression and recovery; rejected token transfers preserve balances; identify whether rejection occurs in resolver, Token-2022 or Aveo | Security specialists implement missing adversarial cases; Bruno reviews enforcement |
| Complete browser flow | Actual preparation, simulation, wallet signing, submission, confirmation and fresh readback; explicit wallet refusal | QA plus an approved extension test wallet; synthetic/read-only browser evidence is insufficient |
| Interrupted-operation recovery | Preserve original signature where available; no success invented from a send error; no automatic or manual duplicate submission while outcome is unresolved; test reload | Backend/QA specialist; wallet sign-and-send response loss without a signature requires a separate persistent safety design |
| Public demonstration | Exact program deployed on devnet; genuine fixtures; public HTTPS Desk; external evaluator repeats all six scenes | Bruno supplies secure program key; deployment/integration specialist creates test fixtures; hosting owner selects destination |
| Clear delivery packet | Clean-clone reproduction, authority inventory, honest limits, license, English presentation/video/links and a first-use rehearsal | Release specialist and consenting first-time evaluator; no fictional audit or pilot evidence |

Parallel code work must have disjoint file ownership. Ledger mutations run
sequentially against fresh disposable fixtures. A reviewer actively attempts
to falsify each acceptance claim, including lost wallet responses, absent
bindings, stale state, mismatched network/binary and missing transaction history.

## Starting evidence, not an audit verdict

### Reconciled implementation baseline — 2026-10-10

This inventory supersedes the older counts below without deleting historical
evidence. Reviewed baseline commit: `7263543`; the worktree was clean before
this increment. Do not repeat completed work or infer that agent activity has
closed a gate without reviewing its code and evidence.

- Shared acceptance manifest version 3 contains 56 live stages. The fresh
  cycle at `/tmp/aveo-local-cycle-2lqUgJ` passed those stages, one-submission
  recovery, independent zero-send recovery and seven controlled HTTP faults.
  Complete security acceptance remains `NOT_FULL`.
- `pnpm verify` passed 2,163 application/script tests, 41 backend tests, types,
  lint and frontend build. The latest presentation increment additionally passed
  four editorial/PDF integrity tests. Existing SQLite/Zod warnings remain.
- Ambiguous transaction responses retain known signatures and block retry in
  the existing executor. Signatureless blocking still does not survive reload;
  asynchronous receipt capture does not establish durable pre-submit intent.
- An independent integration example, an unexecuted operator-pilot kit and the
  versioned Portuguese narrative PDF exist. They are not a published concrete
  SDK integration, an external pilot or a final English submission.
- Clean-clone verification exists with cached dependencies; a fresh operating
  system/toolchain and independent SBF reproduction are not established.
- No real extension-wallet/public-hosting acceptance, independently measured
  commercial benefit or completed external audit is established.

### Seven outcomes and their implementation sequence

These outcomes define an exceptional scoped delivery, not a guaranteed score.
The six mandatory technical conditions above remain the release gate; human
research and commercial evidence are tracked separately rather than simulated.

| Outcome | Already available | Remaining work / owner | Approval evidence |
| --- | --- | --- | --- |
| Working, proven core | Real local transfers, independent transfer client, proof reuse and renewal, 56-stage manifest | Security specialist completes source-binding T04, then T05/T10/T17; Bruno reviews enforcement; orchestrator reruns on fresh fixtures | Every required subcase has correctly attributed rejection, preserved protected state and pinned source/binary/environment |
| Honest failure handling | Unknown outcomes, original-signature reconciliation and controlled transport tests | Backend specialist designs durable pre-submit intent and implements storage/reload/tab safety; Caio reviews; browser QA challenges it | No ambiguous send becomes success/refusal or permits duplicate submission after restart; unavailable storage fails safely |
| Reproducible integration and installation | Workspace example, clean cached clone, current frontend verification | Integration/release specialists finish concrete independent backend consumer, clean build provenance and deploy/host prerequisites | Third party repeats supported inspect/prepare/verify without importing UI internals; exact release and binary identified |
| Experience validated externally | Read-only Chromium walkthrough and emulated narrow viewports | QA prepares actual extension-wallet journey; Bruno recruits a consenting new operator, using PILOT-01 | Actual participant completes main journey and recovery; assistance, confusion and failures recorded; no bot labeled a human |
| Demonstrated differentiation | Proof reuse, independent policies, grouped impact, enforcement outside Desk | Integration/product specialists compare a concrete alternative workflow without assuming superiority | Reproducible comparison explains what Aveo adds and what existing Solana primitives already supply; no MPL compatibility claim without integration |
| Proportional commercial evidence | Initial user/buyer hypothesis and empty pilot measurement template | Product specialist prepares research; Bruno/operator supplies consent and participation | Documented pain and measured task result; payment intent only if actually stated, permission before attribution |
| Coherent promises, docs and code | Dated evidence, threat model, authority limits and Portuguese PDF v0.1 | Orchestrator/release specialist refresh claims after code changes; Bruno approves legal/license choices and presentation | Every shipped claim has evidence or a hypothesis label; English material, video and links match the actual release |

**Implemented increment:** SEC-09 funded source without bindings, for both assets.
One implementation specialist owns fixture creation, missing-binding helper,
runner wiring, unit tests and manifest versioning. A separate read-only reviewer
designs the next recovery increment. Its review found that the incident path drops
signatureless unknown-submission blocking and can label ambiguity as a send failure;
a second implementation specialist owns only incident propagation/model tests and
necessary translations. This partial safety fix must not be described as durable
reload protection. The orchestrator owns this plan, critical review and sequential
ledger validation. No shared ledger mutations in parallel.

**Observed acceptance:** code commits `3e8b7ce` (SEC-09) and `947a81b`
(incident ambiguity) passed `pnpm verify`: 2,230 application/script tests,
41 backend tests, types, lint and frontend build. Strict TypeScript validation
also covers all six changed CLI/script files. Fresh cycle
`/tmp/aveo-local-cycle-QFsPq2` passed five child stages, manifest v4's 59 live
checks, original-signature recovery and seven controlled HTTP faults. SEC-09
transactions failed at slots 4,922 and 4,925 in Token-2022 TLV validation before
the Aveo hook was invoked; protected accounts and balances remained unchanged.
The six-scene read-only packet exported successfully. No new browser/extension,
devnet, external participant or SBF-build acceptance follows from these results.
Full security status remains `NOT_FULL`.

**Deliberately excluded from this increment:** program/account-interface changes,
new dependencies, token economics, AI, real KYC, mainnet, external spending,
outreach without human direction and claims of protocol certification.

**Next execution order:** source-binding acceptance → durable browser recovery
→ remaining adversarial subcases and provenance → public devnet/extension-wallet
journey → external first-use and pilot evidence → final English delivery packet.
Independent tasks may run in parallel, but an unresolved safety finding blocks
release regardless of presentation quality. Devnet authorization is recorded;
secure program-key access and the hosting destination remain external inputs.

### Next recovery increment: durable pre-submit intent

**Status:** design reviewed; not implemented by the incident propagation fix.
**Owner:** backend/browser specialist; Caio reviews, orchestrator falsifies safety
claims. Reuse the existing journal, Web Locks and subscriptions; add no dependency.

1. Reserve one bounded, versioned unresolved intent per browser origin, under the
   existing exclusive lock, before any wallet invocation in the shared execution
   path. Persist only attempt identity, signer, operation kind and safe context
   fingerprints, plus the original signature if obtained; no keys, transaction
   payload, credential-bearing RPC URL or cached confirmation.
2. Validate storage and reread the durable reservation before sending. Missing
   storage/lock support, invalid records, quota errors or another intent produce
   zero wallet and send calls. Context changes, reset, tab changes and receipt
   removal must not release the reservation.
3. Retain it across response loss, reload and late callbacks. Failure to persist
   a signature retains the earlier blocker; never turn a persistence failure into
   permission to resend. Browser storage clearing or a different device remain
   explicit boundaries, not guarantees this design can supply.
4. Reconcile only the matching attempt with sufficient original-context evidence.
   No timeout, elapsed time, eligible balances, missing history or wallet error
   text clears it. Signatureless recovery stays blocked until a separately
   reviewed transaction-to-intent association exists (SEC-10).
5. Hydrate the guard in every sending surface and test a new controller instance,
   two tabs, reload during wallet response, storage/lock failures, late signatures
   and replaced intent records. Separate unit-controlled faults from actual
   browser/extension acceptance. No claim of complete recovery until both pass.

### Historical starting evidence (superseded counts)

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
If public deployment prerequisites remain unavailable, ship verifiable local evidence and
state that limitation rather than pretending it is a public on-chain product.

## Completion rule

The orchestrator reviews evidence and objections, not a target score. A candidate
passes only the gates it demonstrably satisfies. Jury scoring, market adoption
and external audit cannot be guaranteed. Failed gates remain visible with an
owner and next action; no new cosmetic features compensate for missing evidence.
