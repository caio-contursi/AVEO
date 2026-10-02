// Conexão de carteira: Wallet Standard (Phantom, Solflare…) ou, só em localnet e no servidor de
// desenvolvimento, as carteiras sintéticas geradas pelos fixtures. O Desk nunca guarda chaves reais.
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { WalletContext, type ConnectedWallet, type DevWalletOption, type WalletValue } from './context'

const devWalletsSchema = z.object({
  wallets: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      role: z.string(),
      secretKey: z.array(z.number().int().min(0).max(255)).length(64),
    }),
  ),
})

interface LoadedDevWallet extends DevWalletOption {
  signer: KeyPairSigner
}

async function loadDevWallets(): Promise<LoadedDevWallet[]> {
  const response = await fetch('/dev/wallets.json', { cache: 'no-store' })
  if (!response.ok) return []
  const parsed = devWalletsSchema.parse(await response.json())
  return Promise.all(
    parsed.wallets.map(async (w) => {
      const signer = await createKeyPairSignerFromBytes(new Uint8Array(w.secretKey))
      return { id: w.id, label: w.label, role: w.role, address: signer.address, signer }
    }),
  )
}

export function WalletProvider({
  cluster,
  devWalletsEnabled,
  children,
}: {
  cluster: string
  devWalletsEnabled: boolean
  children: ReactNode
}) {
  const [connected, setConnected] = useState<ConnectedWallet | null>(null)
  const enabled = devWalletsEnabled && import.meta.env.DEV && cluster !== 'devnet'
  const devQuery = useQuery({ queryKey: ['dev-wallets'], queryFn: loadDevWallets, enabled, staleTime: Infinity })
  const devWallets = useMemo(() => devQuery.data ?? [], [devQuery.data])

  const connectDev = useCallback(
    async (id: string) => {
      const wallet = devWallets.find((w) => w.id === id)
      if (!wallet) return
      setConnected({ kind: 'dev', address: wallet.address, label: wallet.label, signer: wallet.signer })
    },
    [devWallets],
  )

  const value = useMemo<WalletValue>(
    () => ({
      chain: `solana:${cluster}`,
      connected,
      devWallets: devWallets.map(({ id, label, role, address }) => ({ id, label, role, address })),
      devWalletsEnabled: enabled,
      connectDev,
      setStandard: setConnected,
      disconnect: () => setConnected(null),
    }),
    [cluster, connected, devWallets, enabled, connectDev],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}
