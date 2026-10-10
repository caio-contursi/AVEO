# Aveo localnet audit candidate: threat model

## Scope and evidence boundary

This document describes the existing Aveo SAS/Token-2022 transfer-hook route for
an audit candidate. It is a source-grounded internal assessment, not an
independent audit, production approval, complete security-matrix result or
official MPL-3643 integration. Proofs are synthetic; the system does not perform
real KYC or establish the truth of an issuer's assertions.

The MPL-3643 concerns touched here are identity/eligibility and transfer
restriction. The implemented enforcement is the Aveo hook; the alternative
[MPL backend](../packages/backend-mpl/src/index.ts) returns
`BackendNotIntegrated`. No MPL interoperability or certification follows from
the shared [contracts](../packages/contracts/src/index.ts).

Evidence comes from the current source and existing repository reports. The
[localnet acceptance report](localnet-acceptance.md) records earlier experiments,
including incomplete matrix coverage. Its observations are historical, not a
fresh execution of this candidate. The coordinated candidate includes SAS
parser hardening for canonical pause booleans and signer-vector bounds, with
tests, in [sas.rs](../programs/aveo-hook/src/sas.rs) and
[tests.rs](../programs/aveo-hook/src/tests.rs). That change preserves the ABI but
makes the previous cached binary outdated. The main reviewer subsequently
completed a fresh SBF compilation, hash readback and 42-stage localnet regression;
see [candidate verification](candidate-verification.md). This does not complete
the full security matrix or independent audit.

## Assets, actors and trust boundaries

Assets are token balances and supply, policy configuration, bindings, SAS proofs,
administrative keys, program/binary identity, and truthful operation evidence.
Threat actors include an ineligible holder, a delegate, a caller substituting
accounts, a compromised issuer or SAS signer, a malicious frontend/RPC, and an
operator using stale fixtures or the wrong ledger.

1. Token-2022 authorizes the balance transfer and invokes Aveo. Aveo checks
   eligibility of the owners stored in both token accounts, not the delegate or
   caller's claimed identity.
2. Aveo trusts the configured SAS program's account state and the accepted
   credential/schema pairs. It validates that state; it does not validate the
   underlying identity investigation.
3. The browser Desk reads RPC, prepares/simulates plans and requests signatures.
   Its green verdict cannot authorize a transfer. The live hook decides during
   execution, provided the mint still invokes that hook.
4. The operator trusts the local validator, binaries and RPC for observations.
   Genesis pinning helps prevent mistakes but does not authenticate a malicious
   loopback proxy or provide independent ledger proofs.

## Existing authority inventory

| Authority | Existing power and source | Security consequence / limit |
| --- | --- | --- |
| Current mint authority at policy initialization | `init_policy` requires the mint authority signer and records it as `issuer_authority` in [lib.rs](../programs/aveo-hook/src/lib.rs). | Initial mint creation determines who controls policy. |
| Recorded issuer policy authority | `update_policy` checks signer equality through Anchor constraints; [state.rs](../programs/aveo-hook/src/state.rs) permits changing domain, accepted pairs, required facts and `active`, incrementing `policy_version`. | Can relax requirements, accept another provider or stop transfers. No implemented policy-authority rotation, timelock or approval quorum. Revoking mint authority does not revoke this power. |
| Transfer-hook extension authority | [fixtures.ts](../app/scripts/fixtures.ts) initializes it to the issuer and never revokes it. | Mutable Token-2022 hook configuration can redirect or disable Aveo enforcement. Aveo's hook-ID validation protects calls that reach Aveo; it cannot protect transfers after Aveo is removed. No immutable-hook guarantee. |
| Mint/freeze authorities | Fixtures mint 1,000 units per asset, then set `MintTokens` authority to null; freeze authority starts null. | Further minting is disabled for these completed fixtures. This is fixture behavior, not a runtime hook requirement that every mint authority be null. There is no fixture freeze administrator. |
| Program upgrade authority | Source ID and [Anchor.toml](../Anchor.toml) identify the program, not deployed loader state or an upgrade controller. The [validator script](../app/dev/solana/scripts/run-validator.sh) loads binaries using `--bpf-program`. | An upgradeable deployment's upgrade authority can replace enforcement code. Do not assume an upgrade authority exists, is revoked or is held by the issuer: inspect loader/ProgramData and record the actual result. Local preload does not prove public deployment governance. |
| SAS credential issuer/authority | Fixtures create credentials A/B with each verifier as credential authority and its sole authorized signer. Installed `sas-lib` 1.0.10 exposes `changeAuthorizedSigners`; [SAS compatibility](sas-compatibility.md) documents the pinned account layout. | Credential administration can change the live signer set. The hook rechecks membership, so removing a signer invalidates its bound proofs for subsequent transfers. Aveo has no separate veto over SAS administration. |
| SAS authorized signer | Fixtures issue synthetic payloads; [scenario.ts](../app/scripts/scenario.ts) issues and closes attestations using an authorized verifier. The installed SDK labels close authority an authorized credential signer. | Can assert false facts or close proofs, affecting every binding using them. Closing is not a wallet-authorized unbinding operation. Actual SAS permissions depend on the loaded SAS binary, whose lifecycle is outside Aveo. |
| SAS schema administration | Installed `sas-lib` provides schema creation/status/version instructions; the fixtures create the pinned eligibility schema. [sas.rs](../programs/aveo-hook/src/sas.rs) checks live pause state, layout and relationships. | Schema pause can deny transfers for the accepted pair; a different schema/version needs a policy-accepted pair and suitable bindings. Aveo exposes no schema admin instruction. SDK instruction availability alone is not proof of every external SAS authorization constraint. |
| Subject wallet | `set_binding` requires that subject's signature and pays for its mint/subject binding PDA. | Can replace its own proof reference, but cannot bind a different subject's proof successfully. Binding is not eligibility approval. |
| Token owner/delegate | Token-2022 authorizes token operations; Aveo derives subjects from token-account owners. | Delegate authorization does not substitute the delegate's proof for the holder's. Holder/delegate burn authority is a separate token power outside the hook. |

The demo issuer controls both policy and hook configuration. Each demo verifier
combines credential administration and proof signing. Synthetic key storage in
[lib.ts](../app/scripts/lib.ts) makes these powers accessible to local tooling;
there is no demonstrated separation of duties, hardware custody or multisig.

## Enforcement and threats

| Threat | Existing control | Residual risk / required evidence |
| --- | --- | --- |
| Forged policy, binding or substituted proof | [eligibility.rs](../programs/aveo-hook/src/eligibility.rs) checks Aveo owner, PDA, discriminator/layout version, mint and subject; SAS validates expected addresses, official owner, PDA and cross-account relationships. | SAS program correctness and binary identity remain trusted. Review malformed account boundaries and run live negative cases on the rebuilt binary. |
| Wrong subject, cross-domain reuse or false required facts | [payload.rs](../programs/aveo-hook/src/payload.rs) requires exactly 75 bytes, version 2, 32-byte subject/domain and canonical payload booleans. Execution checks subject, policy domain, pair and required flags. | Domain is a policy value, not automatically unique per deployment. Shared proof reuse across assets in one domain is deliberate. A trusted signer can lie. |
| Expired, closed, paused or signer-revoked proof | Each transfer rereads SAS and uses `Clock.unix_timestamp`; `expiry <= now` fails. Missing/system-owned accounts fail; paused schema and unauthorized signer fail. | Validity can change after simulation. Revocation does not claw back completed transfers or balances. Pause and signer changes can cause broad denial of service. |
| Direct invocation or delegate identity substitution | [token_accounts.rs](../programs/aveo-hook/src/token_accounts.rs) requires Token-2022 ownership and `transferring` flags on both accounts; `execute` checks both mints and stored owners. | Hook context is tied to Token-2022 extension behavior. Live delegate/direct-call evidence is distinct from helper unit tests. |
| Mint extension bypass | Mint validation requires Aveo as hook and rejects PermanentDelegate and confidential transfer mint/fee extensions. | This is not an exhaustive extension allowlist. Hook authority remains mutable in fixtures; extension combinations need review rather than a universal safety claim. |
| Holder chooses a disallowed proof during binding | Binding validates live SAS, subject and domain; execute separately enforces accepted pair and required facts. | Successful binding or renewal cannot be displayed as proof of restored eligibility without fresh execution-oriented readback. |
| Compromised policy/hook/upgrade administrator | Signer checks constrain policy writes; mint and loader authorities are separate mechanisms. | Authorized malicious administration is not prevented. No implemented quorum, delay, authority-change alert or policy history service. |
| Stale/malicious RPC, races or simulation drift | [accounts.ts](../app/src/api/accounts.ts) bounds reads and checks slots/counts; [eligibility.ts](../app/src/api/eligibility.ts) rereads policy/binding/proof state. Execution still checks live chain state. | RPC supplies evidence and can lie or omit history. Separate reads are not one globally atomic snapshot. Simulation does not reserve future state or guarantee execution. |
| Duplicate submission or misleading receipt | [execution.ts](../app/src/features/operations/execution.ts) guards repeated execution and rechecks retained signatures using reads; the journal preserves public context. | Browser storage is editable and not an audit log. [integration.ts](../packages/backend-aveo/src/integration.ts) explicitly does not bind an arbitrary supplied signature to a plan. General backend status/readback is weaker than historical instruction verification. |
| Key exposure or wrong-network use | Local scripts require literal loopback endpoints and reject public genesis hashes; optional explicit genesis pinning; key files are written with restrictive modes. | Protection applies to those scripts, not all wallets/browser flows. Existing-file permissions, machine compromise and all-interface Docker port publication remain operational risks. |

## Mint and burn limitations

The hook implements transfer enforcement; it has no mint or burn entry point.
Token-2022 mint/burn instructions are separate from TransferChecked and do not
gain eligibility enforcement merely because the mint has a TransferHook
extension. The completed demo revokes mint authority, preventing new issuance;
the hook does not itself enforce that revocation. A holder or permitted token
delegate can burn under Token-2022's rules even if Aveo eligibility has expired
or policy is inactive. Burn reduces balance/supply and is not an eligible
transfer, redemption authorization, forced recovery or clawback. No burn-bypass
regression or general issuance/redemption control is established by this document.
The [token SDK burn instruction](../app/package.json) is an existing dependency,
not an Aveo burn-control implementation.

## Candidate objections and proposed backlog issues

Unresolved objections are explicit: administrative bypass through mutable hook
authority; deployment-specific upgrade authority not inventoried here; trusted
SAS facts and administration; no implemented authority rotation/quorum/monitoring;
mint/burn outside enforcement; non-exhaustive extension review; RPC and receipt
trust; and incomplete live adversarial coverage. Parser hardening belongs to
the candidate source; fresh SBF and live regression evidence is recorded in
the candidate verification report. The prior acceptance report alone cannot
close those gates for a new binary, and full adversarial coverage remains open.

Proposed backlog issues (not implemented by this documentation task):

- Capture one public authority/provenance snapshot per candidate, including
  mint extension authorities, loader state, SAS signer/schema state and binary
  hashes, so reviewers can compare the intended and actual trust model.
- Add focused localnet authority-change and burn-boundary evidence using the
  existing stack, so the administrative bypass and transfer-only limits are
  demonstrated rather than inferred from a successful transfer demo.
