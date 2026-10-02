import { useWalletAccountTransactionSendingSigner } from '@solana/react'
import { address } from '@solana/kit'
import { useConnect, useDisconnect, useWallets, type UiWallet, type UiWalletAccount } from '@wallet-standard/react'
import { useEffect, useRef, useState } from 'react'
import { Address } from '../components/Address'
import { useI18n } from '../i18n/context'
import { useWallet } from './context'

/** Transforma a conta Wallet Standard selecionada num TransactionSendingSigner do kit. */
function StandardSignerBridge({ wallet, account, chain }: { wallet: UiWallet; account: UiWalletAccount; chain: `solana:${string}` }) {
  const signer = useWalletAccountTransactionSendingSigner(account, chain)
  const { setStandard } = useWallet()
  useEffect(() => {
    setStandard({ kind: 'standard', address: address(account.address), label: wallet.name, signer })
  }, [account.address, wallet.name, signer, setStandard])
  return null
}

function StandardWalletOption({
  wallet,
  onAccount,
}: {
  wallet: UiWallet
  onAccount: (wallet: UiWallet, account: UiWalletAccount) => void
}) {
  const [isConnecting, connect] = useConnect(wallet)
  return (
    <button
      type="button"
      className="menu-item"
      disabled={isConnecting}
      onClick={async () => {
        const accounts = await connect()
        if (accounts[0]) onAccount(wallet, accounts[0])
      }}
    >
      {wallet.icon && <img src={wallet.icon} alt="" width={18} height={18} />}
      {wallet.name}
    </button>
  )
}

function DisconnectStandard({ wallet, onDone }: { wallet: UiWallet; onDone: () => void }) {
  const [, disconnect] = useDisconnect(wallet)
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="menu-item"
      onClick={async () => {
        await disconnect().catch(() => undefined)
        onDone()
      }}
    >
      {t('wallet.disconnect')}
    </button>
  )
}

export function WalletMenu() {
  const { t } = useI18n()
  const { chain, connected, devWallets, devWalletsEnabled, connectDev, disconnect } = useWallet()
  const wallets = useWallets().filter((w) => w.chains.some((c) => c.startsWith('solana:')))
  const [open, setOpen] = useState(false)
  const [standard, setStandardSelection] = useState<{ wallet: UiWallet; account: UiWalletAccount } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="wallet-menu" ref={ref}>
      {standard && <StandardSignerBridge wallet={standard.wallet} account={standard.account} chain={chain} />}
      <button type="button" className={connected ? 'wallet-button connected' : 'wallet-button primary'} onClick={() => setOpen((v) => !v)}>
        {connected ? (
          <>
            <span className="dot" aria-hidden="true" />
            {connected.label} · <Address value={connected.address} short plain />
          </>
        ) : (
          t('wallet.connect')
        )}
      </button>
      {open && (
        <div className="menu" role="menu">
          {connected ? (
            standard ? (
              <DisconnectStandard
                wallet={standard.wallet}
                onDone={() => {
                  setStandardSelection(null)
                  disconnect()
                  setOpen(false)
                }}
              />
            ) : (
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  disconnect()
                  setOpen(false)
                }}
              >
                {t('wallet.disconnect')}
              </button>
            )
          ) : null}
          <p className="menu-label">{t('wallet.standard')}</p>
          {wallets.length === 0 ? (
            <p className="menu-note">{t('wallet.none', { chain })}</p>
          ) : (
            wallets.map((w) => (
              <StandardWalletOption
                key={w.name}
                wallet={w}
                onAccount={(wallet, account) => {
                  setStandardSelection({ wallet, account })
                  setOpen(false)
                }}
              />
            ))
          )}
          {devWalletsEnabled && devWallets.length > 0 && (
            <>
              <p className="menu-label">{t('wallet.dev')}</p>
              {devWallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={`menu-item ${connected?.address === w.address ? 'active' : ''}`}
                  onClick={async () => {
                    setStandardSelection(null)
                    await connectDev(w.id)
                    setOpen(false)
                  }}
                >
                  {w.label} <Address value={w.address} short plain />
                </button>
              ))}
              <p className="menu-note">{t('wallet.devNote')}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
