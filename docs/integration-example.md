# Independent transfer lifecycle integration

This first milestone provides lifecycle coordination through the existing
`EligibilityBackend` contract. It is not a full SDK, a concrete RPC adapter, or
an official MPL-3643 implementation. The concrete Aveo RPC backend still lives
in the application; extracting its runtime and transaction/evidence parsers is
pending. These helpers do not solve that dependency or prove on-chain behavior.

## API

This is a TypeScript source entry point in the current workspace, exercised with
the existing `tsx` tooling. It is not a published npm package or a standalone
JavaScript distribution. Public here means a declared package export, not an
assertion that the repository or package has been publicly released.

Import the public `@aveo/backend-aveo/integration` entry point:

```ts
import type {
  EligibilityBackend,
  OperationEvidence,
  TransferInput,
  UnsignedPlan,
} from '@aveo/contracts'
import {
  inspectTransfer,
  prepareTransfer,
  verifyPreparedTransfer,
} from '@aveo/backend-aveo/integration'

// The host supplies a real backend configured for the intended RPC/deployment.
// This example has no dependency on Desk UI modules or a pretend RPC adapter.
export async function diagnoseAndPrepare(
  backend: EligibilityBackend,
  input: TransferInput,
): Promise<UnsignedPlan> {
  const diagnostics = await inspectTransfer(backend, input)
  console.log(diagnostics.source, diagnostics.destination)
  // Separate diagnosis is optional. Preparation uses the backend's planning
  // diagnostics rather than adding another pair of inspect calls.
  return prepareTransfer(backend, input)
}

// Call after the host has independently reviewed and submitted the operation.
// Submission, wallet authorization, signing and sending are host responsibilities.
export async function readSubmissionEvidence(
  backend: EligibilityBackend,
  plan: UnsignedPlan,
  cluster: TransferInput['cluster'],
  signature?: string,
): Promise<OperationEvidence> {
  const evidence = await verifyPreparedTransfer(backend, plan, cluster, signature)
  // unknown stays unknown: retain the submission and recheck; do not infer
  // failure or automatically resend because confirmation is unavailable.
  return evidence
}
```

`inspectTransfer` runs source and destination inspection in parallel and returns
the native diagnostics pair, including `ineligible` and `unknown` verdicts and
their reasons. It rejects mismatched backend, cluster, mint or wallet metadata.

`prepareTransfer` checks the transfer capability, calls `planTransfer` once and
returns the original `UnsignedPlan` only when both planning diagnostics are
eligible and match the requested subjects/context. The backend must supply fresh
planning diagnostics; the helper cannot establish their freshness. It requires
the source owner among `requiredSigners`, permits additional fee payer/authority
signers, and rejects an empty transaction. This coordinator covers an owner
signer flow; it does not establish delegate or multisig authorization.

Both functions require each diagnostics pair to report the same RPC URL and
commitment, alongside the requested cluster. Slots may differ because reads are
independent. This is metadata consistency, not an atomic read, an RPC identity
check, a freshness guarantee, or proof of authorization. Context equality is
checked within each pair, not between a standalone diagnosis and later planning.

Preparation rejects ineligible diagnostics with `DeskError('SimulationFailed')`
and unknown diagnostics with `DeskError('ReadUnverifiable')`, including the side
and existing reason codes/messages in the error message. `SimulationFailed` is
the existing planning failure code, not a claim that this helper ran simulation.
Context, subject, backend and signer mismatches use `ReadUnverifiable`;
unsupported planning uses `UnsupportedCapability`. Backend errors propagate.

`verifyPreparedTransfer` checks the plan's internal metadata consistency against
the supplied backend and cluster, then delegates to `verifyOutcome`. Without a
usable signature it returns `unknown` with `ConfirmationUnknown`, without
delegating: there is no execution evidence. With a signature it preserves the
backend evidence object, including unknown, failed or confirmed status, logs,
errors and readback. Verification does not re-inspect eligibility or block an
evidence read because a diagnostic verdict became unknown. Backend errors still
propagate; the host must treat an unavailable verification as unresolved.

## Limits the host must account for

`UnsignedPlan` carries no simulation flag. The host must review the concrete
backend's simulation result before submission. The helper does not inspect
application-specific simulation or blocked fields. It does not decode transaction
bytes, compare the encoded amount/instructions/accounts with `TransferInput`,
validate the encoded signer set, or associate a signature with those bytes.
Those checks belong in the concrete adapter's transaction/evidence parser.

Plans are ordinary mutable contract objects, not authenticated preparation
receipts. Verification has no original request to compare against: coherent
metadata cannot detect arbitrary mutations or prove that a plan was prepared by
this helper. A returned `confirmed` status is the backend's evidence report,
not this coordinator's attestation that the supplied signature executed the
intended transfer. The host must retain and bind its reviewed operation and real
submission signature, and use a backend that verifies the relevant transaction
and execution evidence. Neither eligible diagnostics nor successful metadata
checks prove that the Transfer Hook enforced policy on-chain.

The local tests use injected contract implementations to validate sequencing,
rejection and evidence preservation. They do not use RPC, keys, signing or sending,
and provide no on-chain integration evidence. Full RPC extraction and execution
evidence remain tracked in `docs/backlog.md`.
