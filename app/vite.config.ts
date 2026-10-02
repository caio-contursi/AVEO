import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

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
      }
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? ''
        if (!(pathname in files)) return next()
        const name = files[pathname]
        const file = name ? path.resolve(server.config.root, '.dev', name) : null
        if (!file || !existsSync(file)) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(readFileSync(file))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), devFixtures()],
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
