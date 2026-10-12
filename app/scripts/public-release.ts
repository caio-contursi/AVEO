import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import type { Deployment } from '../src/config/deployment'
import { parsePublicManifest, serializePublicManifest } from './public-manifest'

/** Public releases are explicit; ordinary local builds remain unchanged. */
export function publicRelease(env: Record<string, string | undefined>, root: string): Plugin {
  return {
    name: 'aveo-public-release',
    apply: 'build',
    buildStart() {
      if (env.AVEO_PUBLIC_RELEASE !== 'true') return
      if (env.VITE_CLUSTER !== 'devnet') throw new Error('Public release requires VITE_CLUSTER=devnet')
      if (env.VITE_ENABLE_DEV_WALLETS !== 'false') throw new Error('Public release requires synthetic wallets disabled explicitly')
      if (env.VITE_BACKEND !== 'aveo-sas-hook') throw new Error('Public release requires the implemented Aveo backend')
      if (env.VITE_COMMITMENT !== 'confirmed' && env.VITE_COMMITMENT !== 'finalized') throw new Error('Public release requires confirmed or finalized commitment')
      if (env.VITE_DEPLOYMENT_URL !== '/deployment.json') throw new Error('Public release requires VITE_DEPLOYMENT_URL=/deployment.json')
      const rpc = new URL(env.VITE_RPC_URL ?? '')
      if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.search || rpc.hash) {
        throw new Error('Public release requires an HTTPS RPC URL without embedded credentials or query parameters')
      }
      if (!env.AVEO_PUBLIC_MANIFEST) throw new Error('Public release requires AVEO_PUBLIC_MANIFEST')
      const manifestPath = path.resolve(root, env.AVEO_PUBLIC_MANIFEST)
      if (path.basename(manifestPath).toLowerCase() === 'wallets.json') throw new Error('Wallet key files are not public manifests')
      let manifest: Deployment
      try {
        const resolved = realpathSync(manifestPath)
        if (path.basename(resolved).toLowerCase() === 'wallets.json') throw new Error('Private wallet file')
        manifest = parsePublicManifest(JSON.parse(readFileSync(resolved, 'utf8')))
      } catch {
        // Do not echo untrusted manifest contents or file paths into build logs.
        throw new Error('Public release manifest must be readable, valid public devnet JSON')
      }
      if (env.VITE_AVEO_PROGRAM_ID !== manifest.programs.aveoHook) throw new Error('Public release program ID must match the public manifest')
      this.emitFile({ type: 'asset', fileName: 'deployment.json', source: serializePublicManifest(manifest) })
    },
  }
}
