import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { publicRelease } from './scripts/public-release'
import { localArtifactDirectory } from './scripts/localnet-safety'

/**
 * Só no servidor de desenvolvimento: serve os arquivos gerados pelo script de fixtures (app/.dev).
 * - /dev/deployment.json: manifest com endereços (sem segredos);
 * - /dev/wallets.json: chaves das carteiras sintéticas, apenas com VITE_ENABLE_DEV_WALLETS=true e fora da devnet.
 * Nada disso entra no build de produção.
 */
function devFixtures(): Plugin {
  return {
    name: 'aveo-dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      const env = server.config.env
      const allowWallets = env.VITE_ENABLE_DEV_WALLETS === 'true' && env.VITE_CLUSTER !== 'devnet'
      const files: Record<string, string | null> = {
        '/dev/deployment.json': 'deployment.json',
        '/dev/wallets.json': allowWallets ? 'wallets.json' : null,
        '/dev/judge-evidence.json': env.VITE_CLUSTER === 'localnet' ? 'judge-evidence.json' : null,
      }
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? ''
        if (!(pathname in files)) return next()
        const name = files[pathname]
        const file = name ? path.join(localArtifactDirectory(server.config.root, process.env.AVEO_DEV_DIR), name) : null
        if (!file || !existsSync(file)) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        if (name === 'judge-evidence.json' || name === 'deployment.json') {
          try {
            // Let Vite transform workspace TypeScript instead of Node's strip-only loader.
            const { readJudgeEvidenceResponse, readDevDeploymentResponse } = await server.ssrLoadModule('/scripts/judge-evidence.ts')
            res.end(name === 'judge-evidence.json'
              ? readJudgeEvidenceResponse(path.dirname(file)) : readDevDeploymentResponse(path.dirname(file)))
          } catch {
            res.statusCode = 404
            res.end('not found')
          }
        } else res.end(readFileSync(file))
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), devFixtures(), publicRelease({ ...loadEnv(mode, process.cwd(), ''), ...process.env }, process.cwd())],
  server: { port: 5173, strictPort: true },
  ssr: { noExternal: ['@aveo/contracts'] },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router', '@tanstack/react-query'],
          solana: ['@solana/kit', '@solana/sysvars', '@solana-program/token-2022', '@solana-program/system', '@solana-program/compute-budget'],
          wallet: ['@solana/react', '@wallet-standard/react'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
}))
