# Aveo localnet audit candidate: security operations

## Scope and responsibilities

This runbook prepares and reviews the existing localnet candidate described in
the [threat model](threat-model.md). It authorizes no transactions, deployments,
external outreach or commits by itself. This documentation task performed none.
Any future mutating exercise needs its own localnet authorization and disposable
synthetic fixtures. No production, independent-audit, MPL integration or complete
security-matrix approval is implied.

Bruno owns program/binary identity, mint/policy authority decisions and on-chain
review. Caio owns SAS client/backend, fixture scripts and Desk behavior. Hook
configuration, schema/payload compatibility and operation evidence cross that
boundary and need both owners' review. Documentation assigns responsibilities;
it does not introduce an on-chain approval mechanism.

## Candidate preparation and stop conditions

1. Record the candidate commit plus any uncommitted diff, program ID, toolchain
   versions and fixture directory. A commit ID alone does not identify a dirty
   candidate. Preserve other workers' changes and avoid concurrent policy/proof
   mutation or balance-delta tests on the same subjects.
2. Run the existing offline/local checks from the repository root:

   ```sh
   pnpm verify
   cargo test --locked --offline
   ```

   `pnpm verify` covers workspace/test types, lint, tests and frontend build; it
   does not compile Rust or run a validator. Rust tests require an available
   toolchain/cache. Missing tools or failures remain open gates. Record existing
   warnings rather than calling a warning-bearing build warning-free.
3. Compile a fresh SBF candidate with the pinned tools before live acceptance.
   [build-program.sh](../app/dev/solana/scripts/build-program.sh) uses
   `cargo build-sbf --tools-version v1.53 -- --locked` in a copied workspace.
   The root `build:program` command also generates the IDL. Do not run
   `anchor keys sync`: the fixed ID must not silently change. Record source
   revision/diff, build environment and SHA-256 of the resulting `.so` and the
   SAS/Token-2022 binaries actually loaded.
4. The coordinated SAS parser hardening rejects noncanonical pause bytes and
   bounds signer count by remaining bytes before allocation; it has no ABI
   change. Previous cached binaries and historical acceptance are insufficient.
   Load the newly compiled binary on isolated localnet and run authorized live
   regressions before candidate sign-off. Never relabel a cached hash as a fresh
   build or infer binary equality from matching one source file.
5. Select a fresh ledger/artifact directory outside the repository for mutating
   acceptance. Preserve prior reports. A validator reset loses state/history;
   fixture recreation overwrites its chosen deployment/wallet outputs. Neither
   is an incident-recovery shortcut for evidence you still need.

Do not start the repository's default validator merely to run these checks.
[docker.mjs](../app/dev/solana/docker.mjs) publishes `8899:8899` and `8900:8900`,
and [run-validator.sh](../app/dev/solana/scripts/run-validator.sh) binds
`0.0.0.0`, resets its ledger and may dump uncached SAS/Token-2022 binaries from
devnet. For a local-only candidate, use reviewed cached inputs and an isolated
network with loopback-only exposure as in [localnet acceptance](localnet-acceptance.md).
The stock launcher does not implement that isolation requirement.

## Preflight authority and network record

Before a future authorized signing exercise, establish both literal loopback
endpoints and the actual local genesis from the controlled validator. Pin
`AVEO_RPC_URL`, `AVEO_WS_URL`, `AVEO_LOCAL_GENESIS_HASH` and an explicit absolute
`AVEO_DEV_DIR` for every participating CLI process. A local label or endpoint
alone is insufficient. [localnet-safety.ts](../app/scripts/localnet-safety.ts)
rejects public genesis hashes, URL credentials and ambiguous endpoints;
[lib.ts](../app/scripts/lib.ts) rechecks genesis before signing. Genesis pinning
is optional in shared tooling unless the operator sets it; this runbook requires
it. Do not print environment values containing credentials or open wallet files
to gather public inventory.

Record observed public state with its commitment and slot:

| Item | Required record and decision |
| --- | --- |
| Programs | Configured IDs from [config/programs.json](../config/programs.json), executable state, loader owner and exact loaded binary provenance. An executable address alone is insufficient. |
| Upgrade authority | For each upgradeable program, inspect ProgramData and record controller or null; for a non-upgradeable preload record that loader condition. Include SAS and Token-2022, not only Aveo. Source/config/preflight do not establish these facts. |
| Each mint | Token-2022 owner, decimals, supply, mint/freeze authorities, TransferHook program and authority, extension list. Completed fixture expectation: mint/freeze null, Aveo hook, issuer hook authority, no PermanentDelegate/confidential transfer. |
| Policy | PDA, stored issuer, active flag, version, domain, accepted credential/schema pairs and required facts. Compare actual state to intended Alfa/Beta behavior in [fixtures.ts](../app/scripts/fixtures.ts). |
| SAS | Credential authority and current signer set; schema credential/layout/version/pause state; bound attestation subject/domain/facts/signer/expiry. Record actual accounts, not only manifest labels. |
| Bindings | Correct mint/subject PDAs and proof addresses; evidence that intended subjects reuse a proof across assets. Binding existence does not establish eligibility. |
| RPC/history | Actual genesis and slots, approved endpoint, transaction-history availability and retention expectations. Keep private endpoints out of shared reports. |

[demo-health.ts](../app/scripts/demo-health.ts) provides read-only local readiness
checks for existing fixtures; it is not a full authority or binary attestation.
Stop acceptance on mismatched genesis/IDs/hashes, unexpected authorities or
extensions, unverifiable reads, outdated binaries, failed tests, or missing
historical transaction evidence. Preserve the failed/unknown result.

## Administrative changes: existing mechanisms and limits

Use this sequence for a separately authorized localnet exercise: record before
state and affected subjects/assets; review the exact requested change and signer;
simulate; sign once; retain the original signature; confirm and reread affected
state; then run approved positive and negative transfer checks. A simulation
is not acceptance and a confirmed admin transaction is not proof of restored
eligibility. No change is made by reading this procedure.

| Operation | Existing mechanism | Verification / limitation |
| --- | --- | --- |
| Restrict, relax or deactivate policy | Issuer signs `update_policy`; [backend.ts](../app/src/api/backend.ts) has `planUpdatePolicy`, [lib.rs](../programs/aveo-hook/src/lib.rs) enforces stored issuer. | Check complete domain/pair/fact/active configuration and version, then affected holders. `active=false` blocks hooked transfers and new binding calls; it cannot block burn or protect a mint whose hook was removed. |
| Replace wallet binding | Subject signs `set_binding`; grouped renewal can update several mints in one transaction. | New proof must be live and match subject/domain. Accepted pair/facts are checked at transfer; verify every selected mint afterward. Provider issuance alone does not update bindings. |
| Issue or close SAS proof | [scenario.ts](../app/scripts/scenario.ts) uses verifier signer for issuance and close. | Closure affects all bindings referencing the proof. `scenario close` discovers and loops over proofs for a wallet; do not treat it as a targeted single-proof closure or an atomic batch. Partial completion requires individual signature/state reconciliation. |
| Change SAS authorized signers or schema pause state | Installed pinned SAS SDK exposes these operations; Aveo reads their effects live. | No maintained dedicated Aveo CLI workflow for these admin changes is established here. Review loaded SAS permissions first. Removing a signer/pause can invalidate many proofs; readding/unpausing does not revive closed or expired accounts. |
| Change hook configuration | Token-2022 transfer-hook extension authority, retained by demo issuer. | Can redirect/disable enforcement. No runbook step revokes or rotates it automatically. A policy update cannot repair a changed hook; inspect actual mint configuration. |
| Change program implementation | Deployment-specific loader upgrade authority, if present. | Review binary and authority inventory, fresh SBF build and live regression. There is no demonstrated upgrade approval quorum or public deployment in this procedure. |
| Rotate issuer policy key | No instruction in the existing Aveo interface. | Losing/compromising the stored key has no documented in-place rotation path. Refixture on isolated localnet may create a new asset; it is not rotation of the old policy. |

Policy deactivation is the available policy-level containment measure when the
issuer and original hook remain trustworthy. SAS signer removal, schema pause
and proof closure are different scopes of containment. Neither prevents a
compromised hook/upgrade controller from bypassing or replacing Aveo. The demo's
mint authority is already revoked; burns remain outside eligibility enforcement.

## Incident handling and recovery

For an unexpected transfer or admin-state change, stop further signing in the
affected workflow and preserve public evidence: original signature, context,
slot, transaction instruction/accounts/logs, historical token changes and current
authority state. Distinguish confirmed failure from unavailable confirmation.
Escalate the evidence to the responsible owners through an authorized channel;
this runbook sends no messages and grants no external-outreach authority.

For issuer/SAS/hook/upgrade-key compromise, identify which authority actually
changed and its blast radius before proposing containment. A policy compromise
can affect one mint; a shared credential/signer/proof can affect several; an Aveo
upgrade can affect all mints invoking that program. Existing single-key controls
cannot be described as resilient to controller compromise. There is no automatic
authority monitoring or rollback service implemented in this repository.

For RPC interruption after submission, retain the original signature and ledger
context and recheck using reads. Do not resend because a read timed out. The Desk's
[execution controller](../app/src/features/operations/execution.ts) and
[submission journal](../app/src/features/operations/submission-journal.ts)
support this path, but browser receipts are editable records, not independent
proofs of execution. Confirmation and current eligibility are separate results.

For an existing isolated recovery receipt, the maintained read-only verifier is:

```sh
pnpm local:recovery:resume /absolute/temporary/artifacts/local-recovery-<uuid>.json
```

Set the same approved loopback endpoint/genesis variables first. The matching
`deployment.json` must be beside the receipt.
[local-recovery-resume.ts](../app/scripts/local-recovery-resume.ts) reads public
files/ledger evidence and writes a separate public result; it does not load keys,
sign or submit. It verifies the specific synthetic one-unit TransferChecked
experiment, including historical instructions and balances. It is not a general
plan/signature verifier. Missing/pruned history produces no PASS; it does not
prove the original transaction failed. Generic backend verification and
[integration verification](../packages/backend-aveo/src/integration.ts) do not
provide that same historical instruction binding.

Restoration requires fresh state observations and separately authorized live
checks on the rebuilt candidate, including both allowed and rejected transfers.
Current balances alone cannot reconstruct an old transfer. Do not reset the
ledger, replace fixtures or discard unknown receipts while investigating.

## Secrets and evidence handling

`wallets.json` contains synthetic private keys. Never publish it, deployment
keypairs, signed transaction bytes, seed phrases, `.env` values or authenticated
RPC URLs. [lib.ts](../app/scripts/lib.ts) requests directory/file modes
`0700`/`0600`; that does not repair existing permissions or secure a compromised
machine. Validate permissions on the actual artifact directory. Existing
development key serving is acceptable only within an isolated synthetic setup.
Every `VITE_*` value is public to the browser; display redaction does not make a
provider key secret. See [public-demo-release.md](public-demo-release.md) for
separate future-release prerequisites; do not execute its devnet workflow here.

Retain public before/after state, signatures, slots, hashes, test logs and failed
reports separately from private fixtures. Record which checks were static/unit,
which used live ledger execution, which binary they used and which were not run.
The existing report's partial matrix remains partial until new per-case evidence
establishes otherwise.

## Reviewer objections and proposed backlog issues

The documentation specialist checked all 41 relative source/document links and
whitespace. The orchestrator separately ran the workspace/Rust checks, fresh
SBF compilation, program-byte hash readback and localnet cycle; see
[candidate verification](candidate-verification.md) for actual results and
objections, including existing warnings and formatting deviations. The specialist
performed no transaction or external outreach; the orchestrator's transactions
were exclusively authorized synthetic localnet acceptance.

Complete upgrade/extension authority inventory and SAS binary authorization
review remain required; this document does not assert observed deployment state.
Mutable hook authority, unavailable policy-key rotation, burn bypass, default
all-interface validator exposure, editable receipts and history retention remain
explicit operational limits. Procedures describe human controls; they are not
implemented timelocks, multisig, immutable hooks, alerts or production recovery.

Proposed backlog issues (not implemented here):

- Add a read-only candidate inventory report using existing libraries to compare
  authorities, binaries and genesis with the approved manifest before signing.
- Maintain one isolated rehearsal checklist tying negative transfer/admin cases
  and original-signature recovery to the rebuilt binary, with missing evidence
  explicitly marked rather than summarized as a complete matrix.
