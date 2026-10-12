import type { Address, Instruction, KeyPairSigner, Signature } from '@solana/kit'
import type { ApiContext } from '../src/api/context'
import type { ReasonCode } from '../src/api/diagnostics'
import type { Deployment, DeploymentAsset } from '../src/config/deployment'
import type { PublicEvidence } from './acceptance-report'

// The parent owns network pinning, fixture keys, signing and ledger rejection checks.
export interface AdversarialContext {
  ctx: ApiContext
  deployment: Deployment
  assets: DeploymentAsset[]
  x: KeyPairSigner
  treasury: KeyPairSigner
  issuer: KeyPairSigner
  verifier: KeyPairSigner
  nonce: () => Promise<Address>
  send: (payer: KeyPairSigner, instructions: Instruction[]) => Promise<Signature>
  reject: (payer: KeyPairSigner, instructions: Instruction[], code: ReasonCode) => Promise<unknown>
  transfer: (asset: DeploymentAsset, destination: Address, accepted: boolean,
    code?: ReasonCode, payer?: KeyPairSigner) => Promise<void>
  emit: (evidence: PublicEvidence) => void
  complete: (stage: string) => void
}
