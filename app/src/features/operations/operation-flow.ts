import type { DeskPlan } from '../../api/backend'
import type { ExecutionState } from './execution'

export type StageStatus = 'pending' | 'current' | 'complete' | 'blocked' | 'unknown'
export interface OperationFlowInput {
  plan?: DeskPlan
  planning: boolean
  preparationError?: unknown
  execution: ExecutionState
  contextMatches: boolean
  /** UI-only reference captured at the explicit sign action, never inferred from a new plan. */
  submissionPlan?: DeskPlan
}

export function transferFormLocked(planning: boolean, execution: ExecutionState): boolean {
  return planning || execution.phase === 'signing' || execution.phase === 'verifying'
    || execution.sendBlocked === true
    || execution.evidence?.status === 'unknown'
    || (!!(execution.signature || execution.evidence?.signature) && !execution.evidence)
}

export function operationFlow({ plan, planning, preparationError, execution, contextMatches, submissionPlan }: OperationFlowInput) {
  const stages: [StageStatus, StageStatus, StageStatus, StageStatus] = ['pending', 'pending', 'pending', 'pending']
  const result = (summary: 'ux.nextPrepare' | 'ux.nextPreparing' | 'ux.nextReview' | 'ux.nextWallet' | 'ux.nextConfirm' | 'ux.nextUnknown' | 'ux.nextSubmissionUnknown' | 'ux.nextConfirmed' | 'ux.nextFailed' | 'ux.nextContext' | 'ux.nextBlocked' | 'ux.nextError' | 'ux.nextLocked') => ({ stages, summary })
  const signature = execution.signature || execution.evidence?.signature
  if (!contextMatches) {
    stages[3] = 'unknown'
    return result('ux.nextContext')
  }
  if (signature) {
    // Only the captured plan can supply preparation/review progress for this submission.
    stages[0] = stages[1] = plan && plan === submissionPlan ? 'complete' : 'unknown'
    stages[2] = 'complete'
    if (execution.phase === 'verifying') {
      stages[3] = 'current'
      return result('ux.nextConfirm')
    }
    if (execution.phase === 'done' && execution.evidence?.status === 'confirmed') {
      stages[3] = 'complete'
      return result('ux.nextConfirmed')
    }
    if (execution.evidence?.status === 'failed') {
      stages[3] = 'blocked'
      return result('ux.nextFailed')
    }
    stages[3] = 'unknown'
    return result('ux.nextUnknown')
  }
  if (execution.sendBlocked && execution.error?.code === 'ConfirmationUnknown') {
    stages[0] = stages[1] = plan && plan === submissionPlan ? 'complete' : 'unknown'
    stages[2] = stages[3] = 'unknown'
    return result('ux.nextSubmissionUnknown')
  }
  if (execution.sendBlocked) return result('ux.nextLocked')
  if (execution.phase === 'signing') {
    stages[0] = stages[1] = plan && plan === submissionPlan ? 'complete' : 'unknown'
    stages[2] = 'current'
    return result('ux.nextWallet')
  }
  if (execution.phase === 'verifying' || execution.phase === 'done') {
    stages[3] = 'unknown'
    return result('ux.nextUnknown')
  }
  if (execution.phase === 'error' || execution.error) {
    // A rejected wallet request does not undo review of the exact captured plan.
    if (plan && plan === submissionPlan) stages[0] = stages[1] = 'complete'
    stages[2] = 'blocked'
    return result('ux.nextError')
  }
  if (preparationError) {
    stages[0] = 'blocked'
    return result('ux.nextError')
  }
  if (planning) {
    stages[0] = 'current'
    return result('ux.nextPreparing')
  }
  if (plan) {
    if (plan.blocked || !plan.simulation.ok) {
      stages[0] = 'blocked'
      return result('ux.nextBlocked')
    }
    stages[0] = 'complete'
    stages[1] = 'current'
    return result('ux.nextReview')
  }
  stages[0] = 'current'
  return result('ux.nextPrepare')
}
