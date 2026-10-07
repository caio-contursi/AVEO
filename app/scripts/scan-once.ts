// scan:once fora da interface. Lê a rede e grava o histórico em SQLite.
// Não autoriza transferência: o hook continua decidindo. Repetir não duplica incidente.
//
//   pnpm scan:once
//
// Precisa do manifest gerado por `pnpm fixtures` e do validador em AVEO_RPC_URL (padrão 127.0.0.1:8899).
import path from 'node:path'
import { openIncidentDatabase } from '@aveo/backend-aveo/sqlite'
import { createApiContext } from '../src/api/context'
import { inspectEligibility } from '../src/api/eligibility'
import { EMPTY_STORE, applyScan, type IncidentStoreData } from '../src/features/incidents/model'
import { DEV_DIR, RPC_URL, loadDeployment } from './lib'

const deployment = loadDeployment()
const ctx = createApiContext({
  cluster: deployment.cluster,
  rpcUrl: RPC_URL,
  commitment: 'confirmed',
  programId: deployment.programs.aveoHook,
  deployment,
})

const scope = `${deployment.cluster}:${deployment.programs.aveoHook}:${deployment.generatedAt}`
const database = openIncidentDatabase(path.join(DEV_DIR, 'incidents.sqlite'))

async function main() {
  try {
    const slot = Number(await ctx.rpc.getSlot({ commitment: 'confirmed' }).send())
    const snapshots = []
    for (const wallet of deployment.wallets) {
      for (const asset of deployment.assets) {
        snapshots.push(await inspectEligibility(ctx, asset.mint, wallet.address))
      }
    }
    const previous = database.load<IncidentStoreData>(scope) ?? EMPTY_STORE
    const next = applyScan(previous, snapshots, slot, new Date().toISOString())
    database.save(scope, next)
    const open = next.incidents.filter((incident) => incident.state !== 'resolved')
    console.log(`scan:once slot ${slot}: ${open.length} aberto(s), ${next.incidents.length} no histórico (${databasePath()})`)
    for (const incident of open) {
      console.log(`- ${incident.state} ${incident.type} carteira ${incident.wallet} ativos ${incident.affectedMints.length}`)
    }
  } finally {
    database.close()
  }
}

function databasePath(): string {
  return path.join(DEV_DIR, 'incidents.sqlite')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
