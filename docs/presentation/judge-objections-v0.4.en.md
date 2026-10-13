# Judge objection responses — v0.4

This is an editorial response plan, not a study result, operator testimonial,
score adjustment or acceptance report. The v0.4 pitch changes claims and next-step
clarity; it does not implement the still-open product/security gates.

| Objection | Defensible answer now | Evidence still needed / owner |
| --- | --- | --- |
| Which real operator lost time? | No named external case is documented. Founder experience and public documentation motivate a hypothesis. | Bruno/product: obtain consent, ask about the operator's last blocked-transfer investigation, tools/actions/time and consequences. Do not substitute a fabricated anecdote. |
| What is uniquely Solana? | Current proof readers, policy/binding layouts, transfer construction and verification use SAS/Token-2022. The operator insight could also exist on ERC-3643. | Integration owner/Caio: compare actual adapter work. No implemented EVM/MPL integration, effortless portability or speed/cost superiority claim. |
| Why not Tokeny or scripts? | Tokeny has servicing tools. Scripts/explorers can expose the same facts. Proposed value is a coherent Solana-focused operator workflow. | External operator + QA: run equivalent tasks with manual tools and Desk; measure time, actions, errors and interventions using the [pilot kit](../operator-pilot.md). Benchmark and advantage remain unvalidated. |
| Who pays and how much? | Multi-asset platform; ops/compliance user; head of operations is a budget-owner hypothesis. Subscription/integration revenue is a hypothesis. | Bruno/business: interview the user and decision-maker, identify budget/procurement, then propose a paid pilot and test an actual price. No arbitrary monthly figure presented as willingness to pay. |
| Can a judge finish recovery in two minutes? | Public read-only inspection exists. External wallet provisioning, signed recovery and unassisted end-to-end acceptance remain open. | Integration/QA + human test-wallet owner: execute [the wallet checklist](../current-status.md#wallet-acceptance), six scenes and newcomer rehearsal; record real completion time. The pitch does not claim the two-minute goal is achieved. |
| Who wrote the program and knows Solana? | Project instructions assign program/product ownership to Bruno and Desk/SAS/backend to Caio. Program history includes Caio, Cursor Agent and Codex labels; code is AI-assisted. Ownership and Git authorship are not proof of exclusive human authorship or prior Solana experience. | Team: confirm human instruction-by-instruction contribution/review, experience and additional roles. Project instructions state no prior Rust experience. Retain tests/review evidence and avoid calling internal review an independent audit. |

## Who authorizes eligibility and recovery?

Suggested submission wording:

“SAS eligibility attestations are signed by an authorized verifier under its SAS
credential. Recovery requires a valid replacement attestation and the affected
wallet's signature to update its Aveo binding; the Desk prepares the transaction
and verifies the resulting on-chain state. The asset issuer controls the accepted
verifiers and eligibility policy. Our devnet demonstration uses separate,
team-controlled test keys for issuers, verifiers and wallets, with synthetic
eligibility data—not independent KYC providers.”

In the fixture, Verifiers A and B create credentials listing their own addresses
as authorized signers and sign the attestations. The scenario's proof-closure
operation is signed by the corresponding verifier. Updating an asset policy
requires its issuer authority; updating a binding requires the subject wallet's
signature. A binding update alone does not guarantee eligibility: transfer-time
validation still checks the policy and proof. The Desk does not independently
certify identity, issue a trusted replacement proof or override a rejected
transfer. Separate demo keys are not evidence of independent institutional
custody or a production governance model.

Sources: [devnet fixtures](../../app/scripts/devnet-fixtures.ts),
[scenario operations](../../app/scripts/scenario.ts),
[on-chain signer constraints](../../programs/aveo-hook/src/lib.rs).

## Human actions that slides cannot perform

- Confirm all actual team members and eligibility in the submission portal. The
  claim that only one is registered has not been independently verified here.
  If registration/submission changes are closed, ask the organizer; do not assume
  a pitch update remedies eligibility or can be retroactively submitted.
- Confirm the spoken ownership descriptions with Bruno/Caio and name the other
  contributors accurately. A Git author named Cursor Agent or Codex is not a human
  teammate or independently qualified security auditor.
- Complete the real-wallet acceptance, security gaps and six-scene capture; obtain
  the actual video URLs and test them without login. No recording was generated
  by creating this deck.
- Obtain a consented operator session before attributing need, time savings,
  purchasing intent or feedback to an external person.

## Interview prompts

Ask: “Tell us about the last transfer restriction you investigated. What happened,
which tools did you use, what did you check, and what was hard to establish?”
Then ask: “Who approves operational software, which budget pays, and what evidence
would justify trying a tool?” Do not lead with promised savings or ask the operator
to endorse a predetermined answer. Use anonymized notes and disclose conflicts.

## Evidence basis and limits

Bruno's Computer Science degree, 20-year career and the four students' Information
Systems studies are based on the owner's descriptions in this conversation, not
inferred from Git authorship. They are biographical statements, not external
credential verification. Team registration and detailed contributions still need confirmation.

Technical acceptance: [current status](../current-status.md), [RPC release](../helius-rpc.md),
[security progress](../security-matrix-progress.md), [public gates](../public-demo-release.md).
Task-comparison protocol: [operator pilot](../operator-pilot.md), currently NOT_RUN.
Related products: [Tokeny Servicing App](https://docs.tokeny.com/docs/servicing-app),
[MPL-3643](https://www.metaplex.com/docs/smart-contracts/mpl-3643).
These references support what exists, not a finding that competitors are deficient.

v0.3 remains the more expansive market/founder narrative; v0.4 prioritizes responses
to review objections. Rehearse against the actual video time limit. Do not rush
through caveats or replace technical evidence with a confident performance.
