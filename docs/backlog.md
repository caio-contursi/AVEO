# Delivery backlog

These are repository-local proposed issues, not tickets created in an external tracker.
Public devnet deployment and the six-scene demonstration remain the critical path
described in [public-demo-release.md](public-demo-release.md). Parallel work below
must not change program interfaces, add dependencies or delay that acceptance.

## Optional differentiators — only after mandatory acceptance

**Status:** proposed, not implemented or scheduled. This ordering is an internal
product judgment about feasibility and demonstration value, not a prediction of
judges' scores. More features are not automatically a stronger submission.

**Entry gate:** all six conditions in [audit-candidate-plan.md](audit-candidate-plan.md)
must pass for the delivered release: current evidence, mandatory security cases,
real browser/wallet execution, interruption recovery, public demonstration and
clear delivery material. INT-01 and PILOT-01 remain higher-value work than a new
token or an unverified protocol-compatibility claim.

**Time gate:** reserve time for regression, public-demo rehearsal and submission
before selecting any extra. Allow only one optional slice per implementation
owner at a time; stop if it adds an unresolved security boundary, fails acceptance
or consumes the rehearsal reserve. Do not weaken mandatory gates to make room.
The effort bands below are provisional incremental engineering estimates, not
delivery commitments; they exclude external approvals and provider lead times.

| Order / proposal | Smallest useful slice and likely demonstration benefit | Specialist / human dependency | Effort and acceptance |
| --- | --- | --- | --- |
| 1 — **PLUS-01: bounded incident monitoring** | Reuse existing reads to detect a synthetic proof losing validity, group affected assets and show the last successful observation. Demonstrates proactive operations rather than another dashboard. | Operations/testing specialist; Caio reviews scripts/UI, Bruno reviews the incident narrative. | Approximately 6–12 hours if existing reads suffice. Prove detection, RPC outage, restart and no duplicate alerts on localnet, then the approved devnet release. No signing automation, 24/7 availability claim or production SLA. |
| 2 — **PLUS-02: operator review and handoff** | A compact read-only incident/evidence handoff lets another operator understand what happened and what remains unresolved. Prefer this to a full enterprise user-management system. | UX/backend specialist; Caio owns implementation, Bruno validates usefulness with an operator. | Approximately 6–12 hours for a non-sensitive evidence handoff without accounts. Prove no secrets in exports, unambiguous unknown states and source transaction links. Authenticated multiuser administration is a separate, re-estimated scope requiring server-enforced permissions; a UI role toggle is not access control. |
| 3 — **PLUS-03: advisory explanation, AI optional** | Explain a verified failure and the available next step in plain language. Start with deterministic explanations from existing error/evidence codes; add AI only if it measurably improves understanding. | UX/integration specialist; Caio reviews data boundaries, Bruno approves the product experiment. | Approximately 4–8 hours for deterministic explanations; AI effort remains unestimated until a provider/design is approved. AI must not decide eligibility, change policies or sign. Require explicit human approval for dependencies, cost and external data sharing; test unavailable service and fabricated explanations against verified facts. |
| 4 — **PLUS-04: KYC-provider sandbox adapter** | Demonstrate how a synthetic provider result becomes an attestation consumed by the existing policy. This can clarify the real-world integration boundary without collecting identity documents. | SAS/backend specialist and on-chain reviewer; Caio and Bruno review the shared attestation interface. | Re-estimate after selecting a provider and validating its contract; no provider or new dependency is approved here. Prove accepted, expired and revoked synthetic attestations without bypassing SAS validation. Real KYC requires human-led provider, consent, privacy and data-retention decisions; never put identity documents or personal data on-chain. |
| 5 — **PLUS-05: mainnet-readiness packet, not deployment** | Document release provenance, authority/upgrade powers, operational limits and rollback/incident procedures. Reuse SEC-01 and SEC-02 rather than creating a second audit packet. | Security/release specialist; Bruno owns custody and deployment decisions, an independent auditor owns an actual audit. | Approximately 4–8 hours to consolidate existing evidence, excluding missing controls and external audit. Acceptance is a reproducible packet with explicit gaps, not a production certification. Mainnet deployment, real funds, key custody and audit spending require separate human decisions and are outside this optional implementation authorization. |
| 6 — **PLUS-06: own token — defer unless necessity is demonstrated** | Evaluate a concrete utility that cannot be achieved with existing assets/accounts. A branded token by itself does not strengthen compliance enforcement or prove adoption. | Product/economics reviewer; Bruno decides whether there is a real need. | At most 1–2 hours for a written go/no-go rationale, not token implementation. Default decision: do not build for this submission. Any issuance/economic design needs its own approved scope, risks and tests; no price, fundraising or investment claims. |

**Parallel work boundary:** specialists may prepare scoped designs and tests, but
this backlog entry does not launch agents or authorize feature implementation.
No new stack, major dependencies, personal wallets, real assets or production
identity collection are authorized. Changes crossing Caio/Bruno ownership must
be reviewed by both before implementation.

**Reviewer stop rule:** an optional feature is accepted only with passing tests
and build, a reproducible demonstration and explicit limitations. If it cannot
be verified before release freeze, omit it from the shipped interface and pitch;
retain the proposal here instead of presenting unfinished work as a differentiator.

**Ideator follow-ups:**

- **PLUS-07:** compare the operator's incident-resolution time before and after
  PLUS-01 using the PILOT-01 protocol; label internal measurements separately
  from independent operator evidence.
- **PLUS-08:** use one compact, read-only evidence view for handoff, demonstration
  and integration examples, reducing duplicate screens while retaining origin,
  observation time and unresolved-state warnings.

## INT-01 — Minimal independently usable integration

**Owner:** integration specialist; Caio reviews the backend/application boundary.
**Status:** first increment implemented and verified locally; full integration
remains open. The [example](integration-example.md) uses a framework-independent
diagnosis/preparation/verification workflow with the existing backend contract.

**Why:** an external developer should not need to reproduce the Desk's operational
sequencing or import UI internals to diagnose, prepare and verify an operation.

**First-increment acceptance:** public package entry point, independent example,
tests for blocked/unknown states and mismatching subjects/context, no signing or
sending inside the helper, and explicit separation between a plan and confirmed
execution. A dependency-injected backend is a contract boundary, not a concrete
network integration or a security audit.

**Full acceptance still required:** extract the concrete RPC backend and its
dependencies from the application without duplicating them; run an independent
consumer against real deployed accounts; publish address/transaction/slot evidence
for inspect, prepare and verify; reproduce it from a clean clone. No claim of
MPL-3643 integration or general protocol independence follows from this increment.

## PILOT-01 — Small real-operator pilot

**Owner:** pilot specialist; Bruno owns product/operator selection, Caio owns
technical support, and a human operator owns participation and feedback.
**Status:** [pilot kit](operator-pilot.md) and empty evidence template prepared;
no operator recruited and no pilot executed.

**Why:** test whether incident diagnosis, grouped impact and verified recovery
solve an actual operator problem rather than only a developer demonstration.

**Preparation acceptance:** a targeted recruitment draft, consent and safety
boundaries, reproducible tasks, a fair manual baseline, measurement fields and
an evidence record initially marked NOT_RUN. Do not collect identity documents,
private keys, real assets or real KYC data.

**Full acceptance still required:** external operator agrees to participate;
approved devnet deployment and fixtures exist; the operator performs the tasks;
results are recorded with their limitations and evidence; permission is obtained
before publishing attributable feedback. Internal benchmarks and friendly praise
must not be relabeled as customers, willingness to pay or a validated pilot.

## Follow-up proposals (not part of the current increment)

- **PITCH-01:** validate the Portuguese narrative with a consenting first-time
  reader, recording whether they can explain the user, problem, evidence and
  limitations without prompting; do not count editorial feedback as demand.
- **PITCH-02:** prepare the English submission narrative after public-demo
  acceptance, using the same dated claim inventory and preserving Portuguese
  PDF snapshots rather than silently changing their evidence.
- **INT-02:** run the independent integration consumer in a clean environment
  against an approved devnet release, detecting accidental imports from UI internals.
- **PILOT-02:** repeat the same task protocol with a second independent operator
  to distinguish a reproducible operational benefit from one participant's familiarity.

## Local review, 2026-10-10

`pnpm verify` passed: workspace types, integration test types, frontend test
types, app lint, 1,704 app/script tests, 41 backend tests and the app build.
This increment adds 50 tests: 37 lifecycle, two package entry point and 11 empty
pilot-template integrity tests. Existing SQLite experimental and Zod/Rollup
annotation warnings remain; no new build warnings were observed.

Reviewer objections are reported rather than hidden: the host still supplies
the concrete backend; transaction simulation, encoded instruction validation
and signature-to-operation binding are not established by metadata checks;
the package is workspace TypeScript source, not a published SDK; and template
tests cannot validate a human pilot. No Rust changes, wallet signatures, network
transactions, outreach or real pilot occurred in this increment.

## Local recovery follow-up proposals

- **SEC-01:** generate a read-only authority inventory for a pinned release,
  comparing issuer, hook, mint and upgrade powers with human-approved expectations.
- **SEC-02:** reproduce the audit packet from a clean clone in continuous
  verification, recording binary provenance separately from unit-test results.
- **SEC-03:** version matrix subcases independently of runner stages so an
  operator can see exactly which adversarial boundary remains unexecuted.
- **SEC-04:** add an absent-binding localnet transfer rehearsal that records
  Token-2022 resolver rejection separately from hook rejection, with unchanged balances.
- **SEC-05:** test delayed confirmation and interruption during fixture restoration,
  including an interrupted outbound/return pair, without implying atomic cleanup.
- **SEC-06:** isolate a destination-only revoked signer so acceptance proves the
  destination validation independently of an earlier source failure.
- **DEMO-01:** after approved public deployment, capture the six scenes with an
  extension wallet and publish transaction links tied to the exact release.
- **DEMO-02:** maintain the browser walkthrough in an isolated CI environment,
  keeping real local ledger checks separate from controlled failure responses.
- **SEC-07:** persist an unresolved wallet-submission intent before invoking a
  sign-and-send extension, so a lost response without a signature cannot unlock
  duplicate submission after reload; require an explicit reconciliation path.
- **DEMO-03:** automate hosted-origin checks for genuine devnet evidence,
  manifest coherence and browser RPC access, separate from configuration-only preflight.
- **DEMO-04:** keep desktop scene cards from stretching their grid siblings when
  one technical panel expands, preserving the compact narrative without hiding evidence.
- **SEC-08:** expose the observed rejection layer in public acceptance evidence,
  distinguishing client resolution, Token-2022 TLV validation and an actual Aveo hook failure.
- **SEC-09:** complete T04's absent-source-binding subcase for both assets using
  funded synthetic source accounts created before fixture mint-authority revocation.
  Account for additional supply, isolate valid destinations and verify confirmed
  rejection with unchanged balances and protected bytes; retain NOT_FULL until
  every required subcase has evidence. Caio reviews fixture/script changes and
  Bruno reviews the enforcement assertions.
  Implemented in `3e8b7ce`; fresh v4 local cycle passed both source rejections
  with unchanged balances/state. See [matrix progress](security-matrix-progress.md).
  This does not promote full T04 or the complete security matrix to PASS.
- **SEC-10:** reconcile a signatureless pending intent with a wallet-history
  signature only after transaction-to-intent validation; an unrelated confirmed
  signature must never unlock another submission.
- **SEC-11:** consolidate the source/destination raw-ledger rejection validators
  after their independent acceptance is stable, reducing duplicate checks without
  merging resolver, Token-2022 and Aveo rejection layers.

- **LOCAL-03:** configure and test historical RPC retention in a reproducible
  isolated validator runner, distinguishing unavailable history from a failed
  transaction and proving recovery after a validator restart.
- **LOCAL-05:** require advancing confirmed slots before starting acceptance,
  and serialize memory-heavy checks on constrained machines; a matching genesis
  and successful health response alone do not establish a usable validator.
- **LOCAL-04:** bring the synthetic CLI's transaction-to-receipt verification into
  the Desk's supported operation types, so UI recovery does not rely solely on
  stored metadata or a successful signature status. Expand only with tests for
  each supported instruction shape.

- **LOCAL-05:** share one versioned acceptance-stage manifest between the runner
  and orchestrator, preserving strict evidence checks without duplicating 42 IDs.
  Implemented in `app/scripts/acceptance-stages.ts`; producer and consumer share
  the immutable contract and tests reject incomplete or altered stage sequences.
- **LOCAL-06:** record the acceptance-manifest version in future reports so
  historical evidence identifies its stage contract without changing current
  report compatibility silently.
- **UX-01:** expose the holdings observation slot and shorten the partial-balance
  banner while retaining the distinction between unavailable and zero amounts.
