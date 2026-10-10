// Static public configuration validation; this does not prove a deployment exists on-chain.
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DeploymentError, parseDeployment, type Deployment } from '../src/config/deployment'

function invalid(issue: string): never {
  throw new DeploymentError('invalid', 'public deployment manifest is invalid', [issue])
}

function rejectSecrets(value: unknown, ancestors = new Set<object>()): void {
  if (typeof value === 'string') {
    if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(value)) invalid('secret material is forbidden')
    // Public labels must not carry authenticated URLs or obvious API credentials.
    if (/https?:\/\/[^\s/]*@|[?&](?:api[-_]?key|token|secret|password)=/i.test(value)) {
      invalid('authenticated URLs are forbidden')
    }
    return
  }
  if (value === null || typeof value !== 'object') return
  if (ancestors.has(value)) invalid('cyclic input is forbidden')
  ancestors.add(value)
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (/secret|privatekey|keypair|seed|mnemonic|password|passphrase|apikey|accesstoken|authtoken|bearertoken/.test(normalized)) {
      // Do not echo untrusted field names or values into logs.
      invalid('secret-like fields are forbidden')
    }
    rejectSecrets(child, ancestors)
  }
  ancestors.delete(value)
}

function unique<T>(items: T[], field: keyof T, collection: string): void {
  const seen = new Set<T[keyof T]>()
  for (const item of items) {
    if (seen.has(item[field])) invalid(`${collection}.${String(field)}: duplicate value`)
    seen.add(item[field])
  }
}

/** Accept a JSON-compatible object, returning only fields allowed by the deployment schema. */
export function parsePublicManifest(raw: unknown): Deployment {
  rejectSecrets(raw)
  const deployment = parseDeployment(raw)
  if (deployment.cluster !== 'devnet') invalid('cluster: public manifests require devnet')
  if (!z.iso.datetime({ offset: true }).safeParse(deployment.generatedAt).success
    || !Number.isFinite(Date.parse(deployment.generatedAt))) {
    invalid('generatedAt: expected a valid ISO timestamp with a timezone')
  }
  unique(deployment.assets, 'id', 'assets')
  unique(deployment.assets, 'mint', 'assets')
  unique(deployment.wallets, 'id', 'wallets')
  unique(deployment.wallets, 'address', 'wallets')
  unique(deployment.verifiers, 'id', 'verifiers')
  // An authority can issue multiple schemas. An issuer may also be a wallet or verifier.
  const verifierRecords = deployment.verifiers.map(({ authority, credential, schema }) => ({
    identity: `${authority}:${credential}:${schema}`,
  }))
  unique(verifierRecords, 'identity', 'verifiers')
  return deployment
}

/** Revalidate even typed input so callers cannot serialize additional properties. */
export function serializePublicManifest(raw: unknown): string {
  return `${JSON.stringify(parsePublicManifest(raw), null, 2)}\n`
}

function forbiddenWalletFile(filename: string): boolean {
  return path.basename(filename).toLowerCase() === 'wallets.json'
    && filename.split(path.sep).includes('.dev')
}

/** Explicit paths only; creates a new JSON file in an existing directory. No implicit inputs. */
export async function runPublicManifestCli(args: string[]): Promise<void> {
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    if (!['--input', '--output'].includes(flag) || !value || value.startsWith('--') || options.has(flag)) {
      throw new Error('Usage: public-manifest.ts --input <manifest.json> --output <new-public.json>')
    }
    options.set(flag, value)
  }
  if (options.size !== 2) throw new Error('Both --input and --output paths are required')
  const input = path.resolve(options.get('--input')!)
  const output = path.resolve(options.get('--output')!)
  if (input === output) throw new Error('Output must differ from input')
  if (forbiddenWalletFile(input)) throw new Error('Reading .dev/wallets.json is forbidden')
  if (path.extname(output) !== '.json' || path.basename(output) === 'wallets.json') {
    throw new Error('Output must be a public .json manifest filename')
  }
  const outputDirectory = await realpath(path.dirname(output))
  if (outputDirectory.split(path.sep).some((part) => ['.dev', '.git', 'node_modules'].includes(part))) {
    throw new Error('Output directory is reserved for private or managed files')
  }
  const destination = path.join(outputDirectory, path.basename(output))
  const source = await realpath(input)
  if (forbiddenWalletFile(source)) throw new Error('Reading .dev/wallets.json is forbidden')
  if (source === destination) throw new Error('Output must differ from input')
  if (!(await stat(source)).isFile()) throw new Error('Input must be a regular JSON file')
  const serialized = serializePublicManifest(JSON.parse(await readFile(source, 'utf8')))
  // Exclusive creation also refuses existing symlinks and hard links, protecting the input.
  await writeFile(destination, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPublicManifestCli(process.argv.slice(2)).catch(() => {
    // Schema errors can include untrusted values. Keep CLI errors free of input contents.
    console.error('Public manifest export failed. Check explicit paths and the devnet public deployment schema.')
    process.exitCode = 1
  })
}
