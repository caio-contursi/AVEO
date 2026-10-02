// Variáveis de ambiente do front, validadas na inicialização. Ver app/.env.example.
import { z } from 'zod'

const envSchema = z.object({
  VITE_CLUSTER: z.enum(['localnet', 'devnet']).default('localnet'),
  VITE_RPC_URL: z.url().default('http://127.0.0.1:8899'),
  VITE_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  VITE_AVEO_PROGRAM_ID: z.string().trim().optional(),
  VITE_DEPLOYMENT_URL: z.string().trim().min(1).default('/dev/deployment.json'),
  // mpl3643 fica not-integrated até o gate A (spec v3): o Desk só mostra o aviso.
  VITE_BACKEND: z.enum(['aveo-sas-hook', 'mpl3643']).default('aveo-sas-hook'),
  VITE_ENABLE_DEV_WALLETS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})

export type AppEnv = z.infer<typeof envSchema>

export type EnvResult = { ok: true; env: AppEnv } | { ok: false; issues: string[] }

export function parseEnv(raw: Record<string, unknown>): EnvResult {
  const cleaned = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value === '' ? undefined : value]))
  const result = envSchema.safeParse(cleaned)
  if (result.success) return { ok: true, env: result.data }
  return { ok: false, issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
}

export const envResult: EnvResult = parseEnv(import.meta.env)
