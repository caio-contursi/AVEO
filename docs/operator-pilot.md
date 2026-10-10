# Operator pilot kit

Evidence status: **NOT_RUN**. This is preparation for an independent human
session, not a completed pilot. The [session template](operator-pilot-session.example.json)
is deliberately empty: null measurements mean unmeasured, not zero. No contact,
consent, deployment, public URL, transaction or participant result is asserted.

## Operator and scope

Recruit one external asset-operations or compliance-operations practitioner who
has personally investigated wallet eligibility or restricted-transfer incidents
and can use a test wallet. The participant must not be an Aveo builder, team
member or session facilitator; record prior exposure and conflicts without names.
An internal rehearsal is useful preparation but cannot validate this pilot.

Use the existing SAS / Token-2022 Transfer Hook scenario: synthetic subjects X
and Y, verifier A/B, assets Alfa/Beta and a treasury. Operate only on devnet with
test tokens and test SOL. No real assets, funds, identity checks, customer records
or KYC documents. Synthetic KYC flags are fixture facts, not verified identities.
The scope concerns issuer policy, portable eligibility and transfer enforcement
relevant to MPL-3643; it establishes no official integration or certification.

| Owner | Responsibility |
| --- | --- |
| Bruno | Approve policy expectations, program deployment and authority; review hook outcomes. |
| Caio | Prepare SAS fixtures, Desk/backend access and approved manual tools; review fresh observations. |
| Orchestrator | Recruit only after human authorization, obtain consent, reset fixtures, observe and record measurements; coordinate review. |
| Human operator | Accept voluntarily, perform tasks, approve only understood test-wallet actions, give candid feedback. |

## Recruitment invitation — DRAFT, NOT SENT

> We are preparing a usability session for Aveo Compliance Desk with an external
> operator who has investigated wallet eligibility or restricted transfers.
> You would compare a Desk workflow with a manual workflow using synthetic SAS
> proofs and two test tokens on Solana devnet. There are no real assets or KYC
> checks. We would record anonymous task time, actions, errors and feedback only
> with your consent. You can decline, skip a task or stop. We will never ask for
> private keys or seed phrases. Scheduling and access remain subject to a working
> deployment and public demo. Would you be interested in reviewing the session
> scope before deciding whether to participate?

Sending this draft requires a human's separate authorization. It makes no
duration, savings or benefit promise. Participation is feedback, not a customer
commitment, endorsement or letter of intent.

## Human acceptance and prerequisites

Before recording, explain the scope, measures, who can see notes and an agreed
retention/deletion period. Obtain explicit voluntary acceptance of participation
and anonymous notes; agree how withdrawal and deletion requests will be handled.
Public feedback requires separate permission and review of the exact redacted
excerpt. No recording or screenshots by default. Keep contact coordination
outside the evidence artifact; retain no names, emails, employers, seed phrases,
private keys, wallet exports, personal wallet addresses or private RPC URLs.
Use a random participant code and purpose-built devnet addresses only. Paraphrase
feedback to remove identifying context; do not promise blockchain deletion.

The orchestrator must check each item with the responsible human before starting:

- A real deployment at the configured program ID, matching the reviewed release;
  fresh devnet reads confirm Aveo, SAS and Token-2022 executables and fixture
  accounts. Localnet receipts cannot satisfy this gate.
- A working public HTTPS URL and recorded release commit/manifest; browser routing,
  RPC access and real-wallet flow work from that origin, with dev wallets disabled.
- Bruno confirms deployment/policy authority; Caio confirms the authorized SAS
  attestor. Token issuer policy authority does not authorize SAS proof issuance.
  The fixture's verifier A signs as `vA.signer` (passed as `proof.verifier.signer`
  to SAS `authority`); its credential lists that signer. X signs X's bindings.
  A fee payer pays transaction fees; that role alone grants none of these powers.
  The fixture combines SAS signer and fee payer, but review both roles separately.
  Each subject-wallet owner approves binding and transfer signatures. The operator
  receives no issuer or deployer authority and never shares signing secrets.
- Approved fixture setup/reset on devnet, live and short-lived proofs, equivalent
  baseline/Desk fixture sets, test SOL and sufficient test-token balances. Existing
  localnet scripts are not an approved devnet setup procedure.
- The manual workflow can perform the same checks, transfers and renewal using
  approved existing tools and decoded account reads. If any required operation
  lacks a reviewed manual path, stop that comparison rather than invent commands.
- An eligible independent participant accepts the scope and measurement rules.

See [public release preparation](public-demo-release.md) for deployment gates.
These are prerequisites to verify, not claims that release readiness was tested
here. A missing prerequisite leaves the session NOT_RUN.

## Session tasks

Give the blind task before demonstrating or coaching the six scenes. Provide
only the URL, approved test-wallet access, asset labels and this prompt: “A test
transfer is blocked. Find why, identify the affected assets and explain a safe
next action.” Use an unfamiliar expired shared-proof fixture. Do not reveal the
cause or navigation path. Record completion, confusion and any help requested;
fresh reads must support the diagnosis. Stop before an unexplained signature.
Run its manual counterpart on an equivalent reset fixture and disclose that
learning can affect the second attempt.

| ID | Operator task | Required observable evidence |
| --- | --- | --- |
| S01 | Inspect X across Alfa/Beta; identify the proof and current eligibility. | Fresh reads of both bindings, policies and the same live SAS attestation. |
| S02 | Inspect Y with verifier B; explain why Alfa accepts and Beta rejects. | Fresh reads: Alfa accepts A/B and requires KYC; Beta accepts A and requires KYC plus accreditation. Y has KYC=true, accreditation=false. Identify both Beta's pair mismatch and missing accreditation; the displayed first rejection is not the only mismatch. Stale/UI-only verdicts fail. |
| S03 | Use the approved independent Token-2022 client to attempt an allowed and a policy-blocked transfer outside Desk. | Checked ledger signatures, hook outcome and fresh balances for both attempts; blocked balances unchanged. |
| S04 | Observe X's shared proof expire; attempt a transfer after expiry. | Chain Clock past proof expiry, checked ledger rejection with the expected hook error and unchanged balances. Browser time alone fails. |
| S05 | Find the incident and identify every affected asset. | Fresh expired-proof/binding reads and a redacted Desk observation grouping Alfa/Beta by that same proof. |
| S06 | Review renewal, have the authorized SAS attestor issue a new synthetic proof, and have X approve new bindings; verify recovery. | Checked issuance/binding signatures with their required authorities, fresh shared new-proof/binding/eligibility reads and a checked successful test transfer with balance reads. |

Facilitators perform authorized fixture setup and reset outside measured tasks.
For renewal, record the operator's wait for SAS attestor action within elapsed time.
No facilitator may sign as the participant. A preflight-only rejection is useful
diagnostic evidence but does not satisfy a required ledger-rejection scene.
Never silently resend an unknown transaction; reconcile its signature first.

## Fair manual comparison

Compare the same participant, task outcome, policy facts, permissions, tooling
documentation, commitment and network against equivalent reset fixtures. The
manual condition uses decoded chain reads and approved CLI/client operations
without Desk diagnosis, grouping or renewal planning. Shared fixture setup is
excluded equally. Do not make the baseline depend on memorized layouts or deny
it documentation available to the Desk condition.

Choose and record which condition runs first before measuring; reverse that order
in a subsequent session if one is authorized. Preserve scene dependencies within
each condition. Keep onboarding equivalent and record prior familiarity, tooling
differences, assistance, RPC failures and practice effects. One person's session
cannot establish population-level savings or product demand.

- Time: start at task handoff when its fixture is ready; stop at the evidenced
  outcome or declared stop. Include signing, network/attestor waits and retries.
  Log interruptions; do not silently subtract them. Agree any task timeout in
  advance, report it as incomplete, and never present it as completed timing.
- Actions: count each deliberate click, navigation, submitted command, wallet
  approval/rejection or retry once; typing within a single field is one action.
- Errors: count each distinct wrong action, incorrect diagnosis or failed attempt
  once. Expected policy rejections are required outcomes, not operator errors;
  record infrastructure failures separately in notes.
- Assistance: count each facilitator hint or intervention. Assisted completion
  stays labelled assisted. A skipped or unobserved measure stays null.

Record raw observed measurements for both conditions, including failures. Any
comparison must name the session and limitations. Do not invent statistics,
project savings, timelines or benefits from this empty kit.

## Evidence and human review

Fill a copy of the template only from an actual session. Keep the example empty.
`participant.external` and `independent` start null; `accepted` requires an actual
human decision. Set consent permission only after acceptance; its status then
becomes `granted`. Optional publication permissions remain false unless separately
granted. All measurements are null initially, including completion; zero means
an observed zero. Notes hold redacted context, interruptions and stop reasons.

For each task, `tx_signatures` lists actual submitted signatures only.
`transaction_checks` records objects with `signature`, `confirmed_slot`, `result`
(`succeeded` or `rejected`), `expected_error` (null for success) and `checked`.
Check status, correct cluster/program/accounts, program logs and expected outcome;
an explorer link alone is insufficient. Preserve unresolved signatures as unknown
in notes and block validation. `fresh_reads` records objects with `account`,
`slot`, `purpose` and `checked`; reads must use confirmed commitment and be at
or after the relevant confirmed transaction slot. For read-only scenes record
the current observed slots. `observation_slot` is the minimum slot of the task's
required final read set, not a fabricated confirmation slot. Notes associate
each transaction/read with its condition and attempt.

Status vocabulary for the session and tasks is NOT_RUN, IN_PROGRESS, BLOCKED,
FAILED or VALIDATED. Starting a real consented task permits IN_PROGRESS; missing
or unknown evidence means BLOCKED; an observed unmet outcome means FAILED.
VALIDATED requires an actual external independent human, checked consent and
release prerequisites, all six scenes and the blind task with both conditions
measured, checked required signatures and fresh reads, and human reviewer approval.
Read-only tasks need no transaction signatures. Expected hook rejection can pass
when it matches the scene; an unrelated rejection cannot. Interrupted sessions
retain partial evidence and never become VALIDATED by inference.

The `validation` fields are a **human-reviewed checklist**, not an automatic
evidence validator. Template integrity tests only check artifact structure and
empty defaults; they cannot prove consent, independence, deployment or outcomes.
Do not set a flag true without its reviewed evidence. Review both implementations
with Caio and Bruno and record review time only when review occurs. Even a
VALIDATED session proves only that session's synthetic devnet scope; anonymized
feedback remains feedback, not a customer letter or real compliance evidence.

## Review objections and proposed follow-ups

Open gates: a working deployment/public URL, approved devnet fixture/reset and
manual renewal paths, independent participant/consent, and live evidence still
need verification. No pilot or benefit claim is authorized by this document.
Timing retains network effects and learning bias; disclose both when interpreting
results. Human review remains necessary even when artifact tests pass.

IDEATOR: proposed [backlog](backlog.md) follow-ups are INT-02, a clean-environment
independent consumer check against an approved devnet release to catch UI coupling,
and PILOT-02, a separately authorized second independent operator session. Reversing
condition order in that session could expose learning bias. Neither is implemented
or scheduled by this kit.
