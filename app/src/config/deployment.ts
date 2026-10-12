// Deployment manifest describing the programs and public accounts used by the Desk.
import { isAddress, type Address } from '@solana/kit'
import { z } from 'zod'
import { SAS_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../api/constants'

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), { message: 'endereço Solana inválido' })
  .transform((value) => value as Address)

export const deploymentSchema = z.object({
  version: z.literal(1),
  cluster: z.enum(['localnet', 'devnet']),
  generatedAt: z.string(),
  programs: z.object({
    aveoHook: addressSchema,
    sas: addressSchema.refine((value) => value === SAS_PROGRAM_ID, 'SAS program ID does not match the supported program'),
    token2022: addressSchema.refine((value) => value === TOKEN_2022_PROGRAM_ID, 'Token-2022 program ID does not match the supported program'),
  }),
  /** proof_domain das políticas, em hexadecimal (32 bytes). */
  proofDomain: z.string().regex(/^[0-9a-f]{64}$/, 'proofDomain deve ter 64 caracteres hexadecimais'),
  issuer: addressSchema,
  verifiers: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        authority: addressSchema,
        credential: addressSchema,
        schema: addressSchema,
      }),
    )
    .min(1),
  assets: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        symbol: z.string().min(1),
        mint: addressSchema,
        decimals: z.number().int().min(0).max(9),
      }),
    )
    .min(1),
  wallets: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        address: addressSchema,
        role: z.enum(['treasury', 'investor']),
      }),
    )
    .min(1),
})

export type Deployment = z.infer<typeof deploymentSchema>
export type DeploymentAsset = Deployment['assets'][number]
export type DeploymentWallet = Deployment['wallets'][number]
export type DeploymentVerifier = Deployment['verifiers'][number]

export class DeploymentError extends Error {
  readonly kind: 'not-found' | 'invalid' | 'network'
  readonly issues: string[]

  constructor(kind: DeploymentError['kind'], message: string, issues: string[] = []) {
    super(message)
    this.name = 'DeploymentError'
    this.kind = kind
    this.issues = issues
  }
}

export interface DeploymentTarget {
  cluster: Deployment['cluster']
  programId: Address
}

export function parseDeployment(raw: unknown, target?: DeploymentTarget): Deployment {
  const schema = deploymentSchema.superRefine((deployment, ctx) => {
    if (!target) return
    if (deployment.cluster !== target.cluster) {
      ctx.addIssue({
        code: 'custom',
        path: ['cluster'],
        message: `expected ${target.cluster}, received ${deployment.cluster}`,
      })
    }
    if (deployment.programs.aveoHook !== target.programId) {
      ctx.addIssue({
        code: 'custom',
        path: ['programs', 'aveoHook'],
        message: `expected ${target.programId}, received ${deployment.programs.aveoHook}`,
      })
    }
  })
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new DeploymentError(
      'invalid',
      'deployment manifest is invalid',
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }
  return result.data
}

export async function fetchDeployment(url: string, target: DeploymentTarget): Promise<Deployment> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch (error) {
    throw new DeploymentError('network', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 404) throw new DeploymentError('not-found', `deployment manifest not found at ${url}`)
  if (!response.ok) throw new DeploymentError('network', `HTTP ${response.status} at ${url}`)
  // Servidores de SPA devolvem o index.html no lugar de um arquivo ausente.
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    throw new DeploymentError('not-found', `no JSON manifest at ${url} (got ${response.headers.get('content-type') ?? 'no content-type'})`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new DeploymentError('invalid', `manifest at ${url} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseDeployment(body, target)
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
