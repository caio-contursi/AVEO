import type { Deployment } from '../../config/deployment'
import { shortAddress } from '../../components/format'

/** Nome legível de um endereço conhecido do manifest (carteira, ativo, verificador ou emissor). */
export function labelFor(deployment: Deployment, value: string): string {
  return (
    deployment.wallets.find((w) => w.address === value)?.label ??
    deployment.assets.find((a) => a.mint === value)?.label ??
    deployment.verifiers.find((v) => v.credential === value || v.authority === value)?.label ??
    (deployment.issuer === value ? 'Emissor' : shortAddress(value))
  )
}
