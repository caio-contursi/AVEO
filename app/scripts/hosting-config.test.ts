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
      'VITE_CLUSTER=devnet', 'VITE_RPC_URL=https://aveoprotocol.io/rpc',
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
    const web = compose.split('  aveo-web:\n')[1]!.split('\n  aveo-rpc:\n')[0]!
    expect(web).toContain('network_mode: host')
    expect(compose).not.toMatch(/^\s+(ports|expose|networks):/m)
    expect(read('nginx.web.conf')).toMatch(/^\s+listen 127\.0\.0\.1:8090;$/m)
    expect(read('nginx.web.conf').match(/^\s+listen\b/gm)).toHaveLength(1)
  })
  it('keeps private journal and key exclusions consistent', () => {
    const ignore = read('.dockerignore')
    expect(read('dockerignore.web.txt')).toBe(ignore)
    for (const pattern of [
      '**/.env*', '**/*keypair*.json', '**/wallets.json',
      '**/devnet-wallets.jsonl', '**/devnet-run.jsonl',
    ]) expect(ignore.split('\n')).toContain(pattern)
  })
  it('keeps the RPC service private, read-only, bounded and ready before serving the app', () => {
    const compose = read('compose.web.yaml')
    const rpc = compose.split('\n  aveo-rpc:\n')[1]!.split('\nsecrets:')[0]!
    expect(rpc).toContain('build:\n      context: .\n      dockerfile: ops/rpc-proxy/Dockerfile')
    const rpcDocker = read('ops/rpc-proxy/Dockerfile')
    expect(rpcDocker).toContain('FROM node:22-bookworm-slim')
    expect(rpcDocker).toContain('USER 1002:1002')
    expect(rpcDocker).toContain('CMD ["node", "server.mjs"]')
    expect(rpcDocker).not.toContain('helius_devnet_key')
    expect(rpc).not.toContain('volumes:')
    expect(rpc).toContain('secrets:\n      - helius_devnet_key')
    expect(rpc).toContain('user: "${AVEO_RPC_UID:-1002}:${AVEO_RPC_GID:-1002}"')
    expect(rpc).toContain('network_mode: host')
    expect(rpc).toContain('environment:\n      RPC_BIND_HOST: 127.0.0.1\n      RPC_PORT: "8787"')
    expect(rpc).not.toMatch(/^\s+(ports|expose|networks):/m)
    for (const setting of ['read_only: true', 'no-new-privileges:true', 'cap_drop:\n      - ALL',
      'init: true', 'mem_limit: 256m', 'cpus: 0.5', 'pids_limit: 64',
      'http://127.0.0.1:8787/healthz', 'AbortSignal.timeout(3000)', 'if (!r.ok) process.exit(1)']) {
      expect(rpc).toContain(setting)
    }
    expect(compose).toContain('aveo-rpc:\n        condition: service_healthy')
    expect(compose).toContain('http://127.0.0.1:8090/deployment.json')
    expect(compose).toContain('file: ${HELIUS_DEVNET_KEY_FILE:-/home/bruno/.config/aveo/helius-devnet.key}')
    expect(read('Dockerfile.web')).not.toContain('helius_devnet_key')
    expect(compose).not.toMatch(/api-key=|HELIUS_API_KEY=/)
  })
  it.each(['/rpc', '/rpc-ws'])('proxies exact %s with upgrades, bounded waits and no credential logging or cache', (path) => {
    const nginx = read('nginx.web.conf')
    const block = nginx.split(`location = ${path} {`)[1]!.split('\n    }')[0]!
    expect(nginx).toContain('set $rpc_backend 127.0.0.1:8787;')
    expect(nginx).not.toMatch(/\bresolver\s|aveo-rpc:8787/)
    expect(nginx).toContain("map $http_upgrade $rpc_connection {")
    expect(nginx).toContain("'' close;")
    for (const setting of [`proxy_pass http://$rpc_backend${path};`, 'proxy_http_version 1.1;',
      'proxy_set_header Upgrade $http_upgrade;', 'proxy_set_header Connection $rpc_connection;',
      'proxy_set_header Origin $http_origin;', 'proxy_connect_timeout 5s;', 'proxy_read_timeout 3600s;',
      'proxy_send_timeout 60s;', 'proxy_buffering off;', 'proxy_request_buffering off;', 'proxy_cache off;',
      'add_header Cache-Control "no-store" always;', 'client_max_body_size 1m;',
      'access_log off;', 'error_log /dev/null;']) expect(block).toContain(setting)
    expect(block).not.toMatch(/\$request_uri|\$args|try_files/)
    const format = nginx.match(/log_format web_safe ([^;]+);/)![1]!
    expect(format).toContain('$uri')
    expect(format).not.toMatch(/\$request\b|\$request_uri|\$args|\$http_referer/)
  })
  it('supports deep links but never substitutes HTML for a missing manifest', () => {
    const nginx = read('nginx.web.conf')
    expect(nginx).toContain('location / { try_files $uri $uri/ /index.html; }')
    expect(nginx).toMatch(/location = \/deployment\.json\s*\{\s*add_header Cache-Control "no-store";\s*try_files \$uri =404;/)
  })
})
