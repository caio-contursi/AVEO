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
| Interrupted-operation recovery | Preserve original signature where available; no success invented from a send error; no automatic or manual duplicate submission while outcome is unresolved; test reload | Durable guard and explicit original-message recovery implemented; real extension/ledger interruption acceptance remains open |
| Public demonstration | Exact program deployed on devnet; genuine fixtures; public HTTPS Desk; external evaluator repeats all six scenes | Bruno supplies secure program key; deployment/integration specialist creates test fixtures; hosting owner selects destination |
| Clear delivery packet | Clean-clone reproduction, authority inventory, honest limits, license, English presentation/video/links and a first-use rehearsal | Release specialist and consenting first-time evaluator; no fictional audit or pilot evidence |

Parallel code work must have disjoint file ownership. Ledger mutations run
sequentially against fresh disposable fixtures. A reviewer actively attempts
to falsify each acceptance claim, including lost wallet responses, absent
bindings, stale state, mismatched network/binary and missing transaction history.

## Starting evidence, not an audit verdict

### Durable submission increment — 2026-10-11

Implemented in an isolated worktree on branch `codex/durable-recovery-20261011`,
based on `2ee6c86`. These changes are uncommitted; they are not evidence of the
public site's deployed revision. Existing hosting files and readiness backlog
changes were preserved. This application/backend boundary requires Caio's review;
no on-chain interface, account, protocol, or dependency was changed.
The worktree is retained at `/home/bruno/projetos/AVEO-recovery`, separately from
the original checkout and `AVEO-readiness`.

- `app/src/features/operations/submission-intent.ts` provides a bounded,
  versioned durable reservation under origin-wide Web Locks. The central
  `runPlan` path reserves before wallet access, including incident renewals.
  Missing coordination, malformed storage and persistence failure block sending.
- `app/src/api/transactions.ts` awaits reservation before signing and durable
  signature recording before Desk RPC broadcast. Sending extensions may broadcast
  before returning a signature; losing that response retains the blocker.
- `app/src/api/submission-proof.ts` reads the original wire transaction and
  compares its signature and SHA-256 message fingerprint. Only matched terminal
  evidence at confirmed/finalized commitment releases the reservation. Receipt
  removal, a successful signature status or eligibility readback cannot release it.
- Controlled tests cover unavailable storage, wrong signatures/messages,
  failed writes, pre-wallet cancellation, immutable signatures and release after
  matching transaction evidence. These are not real extension or ledger evidence.
- Real headless Chromium verified secure-context Web Locks, a second-tab block
  and a block after reload. POST requests were disabled: no wallet, RPC mutation
  or blockchain transaction was used in this browser check.
- Final `pnpm verify` passed in the retained worktree: 2,279 app/script tests
  across 84 files, 41 backend tests, application/test typechecks, lint and the
  production build. This is 49 additional app/script tests over the starting
  baseline. Results describe this uncommitted increment, not a published commit.

At the end of this increment, reviewer objections were: the first-render pending-operation UI and
history recovery are not connected yet; signatureless reconciliation remains
SEC-10. Another tab's verified settlement conservatively requires an observing
tab to reload. Clearing browser storage, using another origin/device, compromised
same-origin code and untrusted RPC are outside this client-side guard's guarantee.
The complete extension/ledger recovery acceptance and public devnet release
remain open. Build retains the existing Zod/Rollup annotation warnings; a passing
suite must not be described as warning-free or an independent audit.

### Explicit recovery UI increment — 2026-10-11

This subsequent uncommitted increment uses the same isolated worktree and branch.
The owner confirmed continuing without commits for this round; Git identity was
not configured and no push, deployment, personal wallet, or ledger mutation ran.
This status supersedes the earlier missing-UI/signatureless-controller objections,
not the remaining public-network acceptance requirements.

- `PendingSubmission.tsx` is mounted in `Layout.tsx` across all routes. It reads
  the durable snapshot on first render and warns about unavailable safety storage.
  PT/EN controls support explicit read-only checking, bounded candidate input and
  keyboard access. There is no reset, deletion, resend or automatic recovery.
- `submission-recovery.ts` verifies the original context before RPC, captures
  immutable deployment data and compares the exact transaction signature/message.
  A signature from wallet history is attached only after matched terminal proof.
  Recovery retries the same retained signature after a failed durable attachment.
  A successful chain read without successful durable settlement is not recovery.
- `execution.ts` now uses the originating store throughout initial verification;
  an active attempt missing its record cannot accept terminal backend evidence.
  Context/signature mismatches are rejected before original-message RPC lookup.
- Persistence checks freshness before its final expected-record comparison, then
  writes and reads back without subscriber callbacks. Notifications follow the
  guarded write. Adversarial tests preserve replacement records introduced by
  freshness callbacks or view subscribers rather than silently overwriting them.
- Real headless Chromium checked pending state after reload, keyboard recovery,
  rejection of an unrelated candidate without attachment, valid candidate recovery,
  and a 390px mobile viewport without horizontal overflow. No page errors or RPC
  mutations were observed. RPC results and wire transactions were controlled
  fixtures, not evidence of real wallet signing or on-chain execution.
  Desktop/mobile captures are retained separately at
  `/home/bruno/projetos/AVEO-recovery-evidence-20261011`.
- Final `pnpm verify` passed: 2,347 app/script tests across 86 files, 41 backend
  tests, app/test typechecks, lint and production build. This round adds 68 tests
  over the 2,279-test durable-guard increment. Existing dependency warnings remain.

Remaining objections: extension/local-ledger interruption acceptance, public
devnet delivery and independent first-use/accessibility testing remain open.
Reloaded pre-wallet reservations without an expected message remain blocked and
need an explicitly safe operational resolution; recovery cannot invent a signature
or prove non-broadcast from a wallet error. Concurrent tabs retain conservative
blockers until reload after another tab settles. Native synchronous storage,
cooperating Web Locks and a trusted original RPC remain assumptions; clearing
storage, another origin/device or compromised same-origin code bypass this
client-side guard. No production-audit or protocol-compatibility claim is added.

### Real localnet durable-recovery rehearsal — 2026-10-11

The latest uncommitted increment connects `local-recovery-check.ts` to the same
intent store and exact-message recovery controller used by the Desk. The CLI
persists its message fingerprint before signing and its signature before sending;
it reopens private disk storage in a new store instance after confirmation faults.
Only unknown recovery reads are polled, at 125ms intervals within a bounded stage.
Late signing/proof completion cannot mutate or release through an expired guard.

`local-intent-storage.ts` provides bounded, fsynced metadata in exclusive 0600
files inside a private external temporary directory. Open adapters reject symlinks,
hardlinks, changed inodes and permissive files. A real child-process unit test
verified that a signatureless pending blocker survives reopening without sending.
CLI coordination covers its single private process, not browser Web Locks or
multiple OS writers. Reopening a file establishes a new inode baseline rather
than proving continuity with an earlier adapter.

The existing isolated validator was reused without reset; confirmed slots advanced
and genesis was pinned to `9TsPJrMdoJAFz45vk1wjoDu7pKPmBB1BzDJzCzfodBNP`.
Fresh fixtures were generated in `/tmp/aveo-intent-ledger-Im33Ih`, with dedicated
synthetic wallets, test SOL and Token-2022 assets. No personal wallet, real asset,
devnet/mainnet transaction, public hosting change or new program deployment ran.

- The first rehearsal exposed an early `getTransaction` lookup: its original
  receipt remained `unknown` and its durable blocker remained present. A separate
  process later recovered the same original signature without signing or sending;
  historical verification confirmed hook execution and balances 50/910 to 49/911.
  The failed receipt was not rewritten as a passing run.
- After adding bounded read-only polling, a distinct rehearsal passed with signature
  `22y1FJTRrbwrttU5DPjNLyEkmH8mHabTv1NBZrLSgaXAJ6ZmFGtueXBad1u8CXT7m9fQkpkTK5HEPhrC9SXi1xDC`,
  confirmation/balance slot 194112, and balances 49/911 to 48/912. Its receipt is
  `local-recovery-c58954ac-f925-4aba-b7dc-3ee66bdc3118.json` in that private directory.
  Thus two distinct one-unit rehearsal transfers ran; the first was not resent.
- `local:recovery:resume` independently passed in a new process against each
  historical transaction. The final verification file is
  `local-recovery-resumed-9efcf089-c095-4cfa-9d54-82cdef65362c.json`. It verifies raw
  transfer instructions, the expected sole signature, hook invocation and actual
  historical balance deltas; it never loads keys or submits.

Reviewer limits: public receipt v1 counts signing stages/submission call sites,
not instrumented wallet metrics. `reserve`/`assertOwned` lack their own deadline;
the private cooperating coordination and outer acceptance-stage deadline remain
assumptions. The loaded program binary was reused, not rebuilt/audited this round.
This is real CLI/local-ledger recovery evidence, not extension-wallet browser
acceptance, a validator-restart rehearsal, complete security-matrix acceptance,
final-release binary provenance or public devnet demonstration.

Final verification of this increment: `pnpm verify` passed with 2,366 app/script
tests across 87 files and 41 backend tests, plus typechecks, lint and production
build. This round adds 19 tests over the explicit-recovery UI increment. Existing
SQLite and Zod/Rollup dependency warnings remain; no new dependency was added.

### Observational intent inspection — 2026-10-11

`pnpm --filter @aveo/app local:intent:inspect <absolute-intent-file> [candidate-signature]`
reopens a private isolated intent and verifies exact-message evidence without
loading wallets, signing, sending, attaching a candidate signature or clearing
the persistent gate. This completes the observational part of LOCAL-07, not a
multi-process settlement protocol. The CLI needs only `deployment.json` beside
the intent; `wallets.json` is deliberately unnecessary.

Run with the original literal-loopback endpoint and the expected genesis from
the approved isolated run, for example:

```sh
AVEO_CLUSTER=localnet \
AVEO_RPC_URL=http://127.0.0.1:19899 \
AVEO_WS_URL=ws://127.0.0.1:19900 \
AVEO_LOCAL_GENESIS_HASH=9TsPJrMdoJAFz45vk1wjoDu7pKPmBB1BzDJzCzfodBNP \
pnpm --filter @aveo/app local:intent:inspect \
  /tmp/aveo-intent-ledger-Im33Ih/local-intent-47101203-2f29-4be7-b5c1-fc6aa7ee5c6d.json
```

The concrete file above is a **reconstructed synthetic inspection fixture** for
the previous transfer, not the original interrupted-operation record. It was
created from public deployment metadata and the historical transaction's message
hash/signature, without keys, signing or new transactions. The final command
observed `confirmed`, slot 194112, for the same
`22y1FJTRrbwrttU5DPjNLyEkmH8mHabTv1NBZrLSgaXAJ6ZmFGtueXBad1u8CXT7m9fQkpkTK5HEPhrC9SXi1xDC`
signature. The old receipts and settled intent files were not rewritten.

Interpret the JSON and exit status together:

- `confirmed`: exit 0, matching original message/signature observed on the pinned
  local ledger. `evidenceOnly=true` and `gateReleased=false` remain explicit.
- `failed`: exit 1, a supported instruction-error shape was observed; this is not
  a successful transfer. Unsupported failure metadata stays `unknown`.
- `unknown`, `blocked`, `empty`, `context-mismatch`, `invalid-signature`: exit 2.
  None means the operation was never broadcast or that another send is safe.

The transport allows only genesis/transaction reads, rejects redirects, limits
response bodies to 32 KiB and gives each full fetch/body read a 10-second deadline.
The inspection has a 35-second outer deadline. Context mismatch prevents transaction
reads; genesis is checked before and after the lookup. A final storage refresh must
still match the observed intent. The private gate is never mutated by this command,
so no cross-process writer lock is promised or needed for observation.

Reviewer limits: the legacy record does not contain its original genesis; the
caller must supply a trustworthy pin rather than adopting the current RPC value.
Byte/message equality proves a transaction observation, not an authenticated
deployment history, browser-wallet behavior, recovery after validator restart or
public devnet acceptance. A compromised local RPC and unobserved storage changes
are outside this observation's guarantees. Shared exact-message verification now
rejects coercible/nonpositive slots and malformed error metadata; unsupported
transaction-error variants conservatively retain the blocker.

Four tests run the actual package command in separate processes against controlled
loopback RPC, with no wallet file, covering confirmed, failed, unknown and wrong
genesis. A new late-signer regression proves an expired callback cannot attach,
broadcast or settle. No dependency, on-chain interface, public hosting or deployment
was changed; Caio reviews the application/script boundary.

Final frozen-code verification: `pnpm verify` passed 2,517 app/script tests across
89 files and 41 backend tests, workspace/test typechecks, ESLint and production
build. This increment adds 151 tests over the preceding 2,366-test baseline,
including 66 shared-verifier metadata regressions. Existing SQLite experimental
and two Zod/Rollup annotation warnings remain; no new build warning was observed.
The targeted real-localnet inspection was repeated after the centralized fix and
again returned confirmed slot 194112 with zero signing/submission calls. The
temporary loopback proxy was stopped; the existing isolated validator was retained.
Changes remain uncommitted in the authorized isolated recovery worktree; no public
release commit, Rust rebuild, full security-matrix rerun or extension-wallet browser
acceptance is claimed by these results.

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

### Devnet critical-path increment, 2026-10-11

The owner approved a separate devnet program ID and synthetic devnet signing.
The reviewed identity split, dedicated signer runtime and fixture generator are
implemented without new dependencies or changes to the localnet identity.
See [public-demo-release.md](public-demo-release.md) for the exact identity,
commands, SBF hash, funding estimates and dated network observations.

Current verification: 2,616 app/script tests, 41 backend tests, type checks,
lint and ordinary production build passed; Rust library suites passed 26 tests
each with default and devnet identities. A fresh offline SBF devnet build passed.
The bootstrap contributes 99 regression tests using controlled RPC, not a live
devnet acceptance. Two review findings were corrected: genesis is rechecked
immediately before a faucet request, and private key/signature evidence is
append-only rather than truncated on update.

The new program was absent at the observed devnet slot. One test-funding request
was attempted for a new dedicated payer, without a usable confirmation; its
subsequent observed balance was zero. No deployment or fixture transaction was
submitted. Funding is therefore the immediate external prerequisite, not missing
authorization or an unavailable program key. Real-network fixture execution,
the full security acceptance matrix, extension-wallet recovery and public hosted
acceptance remain open. No independent audit or release sign-off is implied.

The orchestrator reviews evidence and objections, not a target score. A candidate
passes only the gates it demonstrably satisfies. Jury scoring, market adoption
and external audit cannot be guaranteed. Failed gates remain visible with an
owner and next action; no new cosmetic features compensate for missing evidence.
