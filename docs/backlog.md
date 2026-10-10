# Delivery backlog

These are repository-local proposed issues, not tickets created in an external tracker.
Public devnet deployment and the six-scene demonstration remain the critical path
described in [public-demo-release.md](public-demo-release.md). Parallel work below
must not change program interfaces, add dependencies or delay that acceptance.

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

- **LOCAL-03:** configure and test historical RPC retention in a reproducible
  isolated validator runner, distinguishing unavailable history from a failed
  transaction and proving recovery after a validator restart.
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
