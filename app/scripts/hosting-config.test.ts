import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AVEO_DEVNET_HOOK_PROGRAM_ID } from '../src/api/constants'

const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')

describe('public VPS hosting contract', () => {
  it('requires a build-only manifest mount and the validated public build', () => {
    const docker = read('Dockerfile.web')
    expect(docker).toContain('--mount=type=secret,id=aveo_public_manifest,required=true')
    expect(docker).toContain('AVEO_PUBLIC_MANIFEST=/run/secrets/aveo_public_manifest pnpm build:public')
    expect(docker).not.toMatch(/RUN pnpm --filter @aveo\/app build\s/)
    expect(docker).not.toContain('COPY deployment.json')
  })
  it('pins the approved devnet configuration and disables synthetic browser wallets', () => {
    const docker = read('Dockerfile.web')
    for (const setting of [
      'VITE_CLUSTER=devnet', 'VITE_RPC_URL=https://api.devnet.solana.com',
      'VITE_COMMITMENT=confirmed', `VITE_AVEO_PROGRAM_ID=${AVEO_DEVNET_HOOK_PROGRAM_ID}`,
      'VITE_BACKEND=aveo-sas-hook', 'VITE_DEPLOYMENT_URL=/deployment.json',
      'VITE_ENABLE_DEV_WALLETS=false',
    ]) expect(docker).toContain(setting)
  })
  it('copies only the generated application into the final image', () => {
    const finalStage = read('Dockerfile.web').split('FROM nginx:')[1]
    expect(finalStage).toBeDefined()
    expect(finalStage).toContain('COPY --from=build /src/app/dist /usr/share/nginx/html')
    expect(finalStage).not.toContain('/run/secrets')
    expect(finalStage).not.toContain('COPY . .')
  })
  it('requires an explicit manifest path in compose and keeps the listener private', () => {
    const compose = read('compose.web.yaml')
    expect(compose).toContain('file: ${AVEO_PUBLIC_MANIFEST:?')
    expect(compose).toMatch(/secrets:\s+- aveo_public_manifest/)
    expect(compose).toContain('127.0.0.1:8090:80')
  })
  it('keeps private journal and key exclusions consistent', () => {
    const ignore = read('.dockerignore')
    expect(read('dockerignore.web.txt')).toBe(ignore)
    for (const pattern of [
      '**/.env*', '**/*keypair*.json', '**/wallets.json',
      '**/devnet-wallets.jsonl', '**/devnet-run.jsonl',
    ]) expect(ignore.split('\n')).toContain(pattern)
  })
  it('supports deep links but never substitutes HTML for a missing manifest', () => {
    const nginx = read('nginx.web.conf')
    expect(nginx).toContain('location / { try_files $uri $uri/ /index.html; }')
    expect(nginx).toMatch(/location = \/deployment\.json\s*\{\s*add_header Cache-Control "no-store";\s*try_files \$uri =404;/)
  })
})
