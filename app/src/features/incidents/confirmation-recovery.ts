import type { Signature } from '@solana/kit'
import type { DeskEvidence } from '../../api/backend'
import type { ApiContext } from '../../api/context'
import { confirmSignature } from '../../api/transactions'
import type { SubmissionJournal } from '../operations/submission-journal'
import type { DeskIncident } from './model'
import { unknownIncidentSignatures } from './confirmation-model'

/** Query public metadata only; never reconstruct an intent, access a wallet or submit. */
export async function recheckIncidentSignature(
  ctx: ApiContext, incident: DeskIncident, signature: string,
  journal: Pick<SubmissionJournal, 'getSnapshot' | 'matches'>,
  isCurrent: () => boolean = () => true,
): Promise<DeskEvidence | undefined> {
  try {
    if (!isCurrent() || !unknownIncidentSignatures(incident).includes(signature) ||
      (ctx.commitment !== 'confirmed' && ctx.commitment !== 'finalized')) return undefined
    const entries = incident.evidence.filter((entry) => entry.signature === signature)
    if (entries.length !== 1 || entries[0]!.status !== 'unknown') return undefined
    const receipts = journal.getSnapshot().filter((receipt) => receipt.signature === signature)
    if (receipts.length !== 1) return undefined
    const receipt = receipts[0]!
    const stillCurrent = () => {
      if (!isCurrent()) return false
      const current = journal.getSnapshot().filter((entry) => entry.signature === signature)
      return current.length === 1 && current[0] === receipt
    }
    if (!await journal.matches(ctx, receipt) || !stillCurrent()) return undefined
    let observation
    try { observation = await confirmSignature(ctx, signature as Signature, 15_000) } catch {
      if (!stillCurrent()) return undefined
      return { status: 'unknown', signature, logs: [] }
    }
    if (!stillCurrent()) return undefined
    const floor = Math.max(incident.detectedSlot, entries[0]!.slot ?? 0)
    if ((observation.status === 'confirmed' || observation.status === 'failed') &&
      Number.isSafeInteger(floor) && floor >= 0 &&
      Number.isSafeInteger(observation.slot) && observation.slot! > 0 && observation.slot! >= floor) {
      return { status: observation.status, signature, slot: observation.slot, logs: [] }
    }
    // Raw logs/provider messages and cached eligibility do not belong to confirmation recovery.
    return { status: 'unknown', signature, logs: [] }
  } catch {
    return undefined
  }
}
