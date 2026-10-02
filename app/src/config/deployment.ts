// Manifest de deploy: quais mints, verificadores e carteiras a demo usa.
// O plano do time prevê config/deployments.devnet.json (F2), que ainda não existe; este é o formato
// que o front espera (ver docs/backend-pendencias.md). Em localnet, o script de fixtures gera o arquivo.
import { isAddress, type Address } from '@solana/kit'
import { z } from 'zod'

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
    sas: addressSchema,
    token2022: addressSchema,
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

export function parseDeployment(raw: unknown): Deployment {
  const result = deploymentSchema.safeParse(raw)
  if (!result.success) {
    throw new DeploymentError(
      'invalid',
      'deployment manifest is invalid',
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }
  return result.data
}

export async function fetchDeployment(url: string): Promise<Deployment> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch (error) {
    throw new DeploymentError('network', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 404) throw new DeploymentError('not-found', `deployment manifest not found at ${url}`)
  if (!response.ok) throw new DeploymentError('network', `HTTP ${response.status} at ${url}`)
  return parseDeployment(await response.json())
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
