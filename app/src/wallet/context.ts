import type { Address, TransactionSigner } from '@solana/kit'
import { createContext, useContext } from 'react'

export interface ConnectedWallet {
  kind: 'standard' | 'dev'
  address: Address
  label: string
  /** Carteira Wallet Standard: assina e envia. Carteira sintética: assina e o Desk envia. */
  signer: TransactionSigner
}

export interface DevWalletOption {
  id: string
  label: string
  role: string
  address: Address
}

export interface WalletValue {
  chain: `solana:${string}`
  connected: ConnectedWallet | null
  devWallets: DevWalletOption[]
  devWalletsEnabled: boolean
  connectDev: (id: string) => Promise<void>
  setStandard: (wallet: ConnectedWallet | null) => void
  disconnect: () => void
}

export const WalletContext = createContext<WalletValue | null>(null)

export function useWallet(): WalletValue {
  const value = useContext(WalletContext)
  if (!value) throw new Error('useWallet outside WalletProvider')
  return value
}
