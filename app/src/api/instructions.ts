// Instruções do aveo-hook, com as contas na ordem dos structs #[derive(Accounts)] de lib.rs.
import { AccountRole, type Address, type Instruction, type TransactionSigner } from '@solana/kit'
import { initExtraMetasData, initPolicyData, setBindingData, updatePolicyData, type PolicyArgs } from './codecs'
import { SYSTEM_PROGRAM_ID } from './constants'
import { findBindingPda, findExtraAccountMetasPda, findPolicyPda } from './pdas'

const readonly = (address: Address) => ({ address, role: AccountRole.READONLY })
const writable = (address: Address) => ({ address, role: AccountRole.WRITABLE })
const signer = (s: TransactionSigner, isWritable: boolean) => ({
  address: s.address,
  role: isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER,
  signer: s,
})

/** set_binding: assinado pela própria carteira (subject_wallet), que também paga o aluguel do binding. */
export async function getSetBindingInstruction(input: {
  programId: Address
  subject: TransactionSigner
  mint: Address
  credential: Address
  schema: Address
  attestation: Address
}): Promise<Instruction> {
  const policy = await findPolicyPda(input.programId, input.mint)
  const binding = await findBindingPda(input.programId, input.mint, input.subject.address)
  return {
    programAddress: input.programId,
    accounts: [
      signer(input.subject, true),
      readonly(input.mint),
      readonly(policy),
      writable(binding),
      readonly(input.credential),
      readonly(input.schema),
      readonly(input.attestation),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    data: setBindingData(),
  }
}

/** update_policy: só o issuer_authority gravado na política. */
export async function getUpdatePolicyInstruction(input: {
  programId: Address
  authority: TransactionSigner
  mint: Address
  args: PolicyArgs
}): Promise<Instruction> {
  const policy = await findPolicyPda(input.programId, input.mint)
  return {
    programAddress: input.programId,
    accounts: [signer(input.authority, false), writable(policy), readonly(input.authority.address)],
    data: updatePolicyData(input.args),
  }
}

/** init_policy: assinado pela mint authority atual (usado pelos scripts de desenvolvimento). */
export async function getInitPolicyInstruction(input: {
  programId: Address
  authority: TransactionSigner
  mint: Address
  args: PolicyArgs
}): Promise<Instruction> {
  const policy = await findPolicyPda(input.programId, input.mint)
  return {
    programAddress: input.programId,
    accounts: [signer(input.authority, true), readonly(input.mint), writable(policy), readonly(SYSTEM_PROGRAM_ID)],
    data: initPolicyData(input.args),
  }
}

/** init_extra_metas: cria a ExtraAccountMetaList oficial do mint (usado pelos scripts de desenvolvimento). */
export async function getInitExtraMetasInstruction(input: {
  programId: Address
  authority: TransactionSigner
  mint: Address
}): Promise<Instruction> {
  const policy = await findPolicyPda(input.programId, input.mint)
  const extraMetas = await findExtraAccountMetasPda(input.programId, input.mint)
  return {
    programAddress: input.programId,
    accounts: [
      signer(input.authority, true),
      readonly(input.mint),
      readonly(policy),
      readonly(input.authority.address),
      writable(extraMetas),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    data: initExtraMetasData(),
  }
}
