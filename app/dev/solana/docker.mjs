#!/usr/bin/env node
// Ambiente local da Solana para testar o front contra o backend real (aveo-hook + SAS + Token-2022).
// Não faz parte do backend: o repositório é montado somente para leitura e nada nele é alterado.
//
// Uso (a partir de app/):
//   node dev/solana/docker.mjs image       constrói a imagem
//   node dev/solana/docker.mjs build       instala o Agave e compila o aveo-hook
//   node dev/solana/docker.mjs validator   sobe o validador local em http://127.0.0.1:8899
//   node dev/solana/docker.mjs logs        acompanha os logs do validador
//   node dev/solana/docker.mjs stop        derruba o validador
//
// AVEO_DEV_HOME define onde ficam toolchain, cache e build (padrão: ~/.aveo-dev).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const devHome = path.resolve(process.env.AVEO_DEV_HOME ?? path.join(homedir(), '.aveo-dev'))
const image = 'aveo-dev-solana:local'
const container = 'aveo-validator'
const rpcUrl = 'http://127.0.0.1:8899'

function docker(args, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync('docker', args, { stdio: quiet ? 'ignore' : 'inherit' })
  if (result.error) {
    console.error('Docker não encontrado. Instale e inicie o Docker antes.')
    process.exit(1)
  }
  if (result.status !== 0 && !allowFailure) process.exit(result.status ?? 1)
  return result.status === 0
}

function mounts() {
  mkdirSync(path.join(devHome, 'cache'), { recursive: true })
  return [
    '-v', `${devHome}:/opt/aveo-dev`,
    '-v', `${path.join(devHome, 'cache')}:/root/.cache/solana`,
    '-v', `${repoRoot}:/src:ro`,
  ]
}

// setx só vale para terminais abertos depois (no VS Code, depois de reiniciá-lo): sem a variável,
// o padrão ~/.aveo-dev fica vazio e o validador não teria o que carregar.
function requireBuild() {
  const program = path.join(devHome, 'out', 'aveo_hook.so')
  if (existsSync(program)) return
  console.error(`Programa compilado não encontrado em ${program}.`)
  if (process.env.AVEO_DEV_HOME) {
    console.error('Rode antes: pnpm solana:build')
  } else {
    console.error('AVEO_DEV_HOME não está definido neste terminal, então foi usado o padrão ~/.aveo-dev.')
    console.error('Defina a variável com a pasta das ferramentas (ex.: E:\\aveo-dev) num terminal novo, ou rode pnpm solana:build.')
  }
  process.exit(1)
}

function containerRunning() {
  const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' })
  return result.status === 0 && result.stdout.trim() === 'true'
}

function ensureImage() {
  if (!docker(['image', 'inspect', image], { allowFailure: true, quiet: true })) {
    docker(['build', '-t', image, here])
  }
}

async function waitForRpc(timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!containerRunning()) return 'exited'
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      })
      const body = await response.json()
      if (body.result === 'ok') return true
    } catch {
      // validador ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

const command = process.argv[2]
switch (command) {
  case 'image':
    docker(['build', '-t', image, here])
    break
  case 'build':
    console.log(`Pasta das ferramentas (AVEO_DEV_HOME): ${devHome}`)
    ensureImage()
    docker(['run', '--rm', ...mounts(), image, 'bash', '-c', '/usr/local/bin/aveo/setup.sh && /usr/local/bin/aveo/build-program.sh'])
    break
  case 'validator': {
    requireBuild()
    ensureImage()
    docker(['rm', '-f', container], { allowFailure: true, quiet: true })
    docker([
      'run', '-d', '--name', container,
      '--ulimit', 'nofile=1000000:1000000',
      '-p', '8899:8899', '-p', '8900:8900',
      ...mounts(), image, '/usr/local/bin/aveo/run-validator.sh',
    ])
    console.log(`Aguardando o validador em ${rpcUrl}…`)
    const ready = await waitForRpc()
    if (ready === true) {
      console.log('Validador pronto.')
    } else if (ready === 'exited') {
      console.error('O validador parou ao iniciar. Últimas linhas do log:')
      docker(['logs', '--tail', '20', container], { allowFailure: true })
      process.exit(1)
    } else {
      console.error('O validador não respondeu a tempo. Veja: node dev/solana/docker.mjs logs')
      process.exit(1)
    }
    break
  }
  case 'logs':
    docker(['logs', '-f', '--tail', '50', container])
    break
  case 'stop':
    docker(['rm', '-f', container], { allowFailure: true })
    break
  default:
    console.log('Comandos: image | build | validator | logs | stop')
    process.exit(command ? 1 : 0)
}
