import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import type { DeskPlan } from '../../api/backend'
import type { DeskSnapshot } from '../../api/diagnostics'
import { useReadyDesk } from '../../app/desk'
import { formatAmount } from '../../components/format'
import { ReasonList } from '../../components/reasons'
import { Card, ErrorState, Field, Spinner, VerdictBadge } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { useWallet } from '../../wallet/context'
import { useHoldingsQuery } from '../assets/queries'
import { EvidenceView } from '../operations/EvidenceView'
import { OperationFlow } from '../operations/OperationFlow'
import { transferFormLocked } from '../operations/operation-flow'
import { labelFor } from '../operations/labels'
import { PlanReview } from '../operations/PlanReview'
import { useExecutePlan } from '../operations/useExecutePlan'
import { usePlanPreparation } from '../operations/usePlanPreparation'

interface FormState {
  asset: string
  from: string
  to: string
  amount: string
}

type FormErrors = Partial<Record<keyof FormState, string>>

function PartyCard({ title, snapshot }: { title: string; snapshot: DeskSnapshot }) {
  const { t } = useI18n()
  const { deployment } = useReadyDesk()
  return (
    <Card title={`${title}: ${labelFor(deployment, snapshot.wallet)}`} aside={<VerdictBadge verdict={snapshot.verdict} />}>
      {snapshot.proof ? (
        <p className="small">{labelFor(deployment, snapshot.proof.credential)}</p>
      ) : (
        <p className="small muted">{t('detail.noProof')}</p>
      )}
      {snapshot.verdict === 'eligible' && snapshot.reasons.length === 0 ? <p className="small ok-text">{t('detail.allGood')}</p> : <ReasonList reasons={snapshot.reasons} />}
    </Card>
  )
}

export function TransferPage() {
  const { t, locale } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const { connected } = useWallet()
  const holdings = useHoldingsQuery()
  const execution = useExecutePlan()
  const submissionPlan = useRef<DeskPlan | undefined>(undefined)
  const investor = deployment.wallets.find((w) => w.role === 'investor') ?? deployment.wallets[0]!
  const [form, setForm] = useState<FormState>({
    asset: deployment.assets[0]!.id,
    from: investor.address,
    to: deployment.wallets.find((w) => w.address !== investor.address)!.address,
    amount: '1',
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const preparation = usePlanPreparation<DeskPlan>([
    ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment, form, connected?.address,
  ])
  const { plan, planning } = preparation
  const formLocked = transferFormLocked(planning, execution.state)
  const blocked = !!plan && (!!plan.blocked || !plan.simulation.ok)

  // Suggest a connected manifest wallet only before an operation starts.
  useEffect(() => {
    if (execution.state.phase !== 'idle' || execution.state.sendBlocked) return
    if (connected && deployment.wallets.some((w) => w.address === connected.address)) {
      setForm((f) => (f.from === connected.address ? f : { ...f, from: connected.address }))
    }
  }, [connected, deployment.wallets, execution.state.phase, execution.state.sendBlocked])

  const asset = deployment.assets.find((a) => a.id === form.asset)!
  const currentHoldings = holdings.error || holdings.isFetching ? undefined : holdings.data?.holdings
  const partialHoldings = currentHoldings?.some((row) => row.amount === undefined)
  const holdingOf = (wallet: string) => currentHoldings?.find((h) => h.mint === asset.mint && h.wallet === wallet)
  const balanceOf = (wallet: string) => holdingOf(wallet)?.amount
  const balanceHint = (wallet: string) => {
    const holding = holdingOf(wallet)
    if (!holding) return undefined
    return holding.amount !== undefined
      ? t('transfer.balance', { amount: formatAmount(locale, holding.amount, asset.decimals) })
      : t('ux.balanceUnavailable')
  }

  const update = (patch: Partial<FormState>) => {
    if (!execution.reset()) return
    submissionPlan.current = undefined
    preparation.clear()
    setForm((f) => ({ ...f, ...patch }))
  }

  const validate = (): bigint | undefined => {
    const schema = z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      amount: z.string().regex(/^\d+$/, t('transfer.errorAmount')),
    })
    const parsed = schema.safeParse(form)
    const next: FormErrors = {}
    if (!parsed.success) for (const issue of parsed.error.issues) next[issue.path[0] as keyof FormState] = issue.message
    if (form.from === form.to) next.to = t('transfer.errorSame')
    let amount: bigint | undefined
    if (!next.amount) {
      amount = BigInt(form.amount)
      if (amount <= 0n) next.amount = t('transfer.errorAmount')
      const balance = balanceOf(form.from)
      if (balance !== undefined && amount > balance) next.amount = t('transfer.errorBalance')
    }
    setErrors(next)
    return Object.keys(next).length === 0 ? amount : undefined
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const amount = validate()
    if (amount === undefined) return
    if (!execution.reset()) return
    submissionPlan.current = undefined
    const request = { cluster: ctx.cluster, mint: asset.mint, sourceOwner: form.from, destinationOwner: form.to, amount }
    await preparation.prepare((signal) => backend.planTransfer(request, signal))
  }

  const sign = () => {
    if (!plan || blocked || !preparation.isCurrent(plan)) return
    submissionPlan.current = plan
    const before = [balanceOf(form.from), balanceOf(form.to)]
    void execution.execute(plan, { balancesBefore: before.every((b) => b !== undefined) ? (before as bigint[]) : undefined })
  }

  return (
    <div className="stack">
      <OperationFlow plan={plan} planning={planning} preparationError={preparation.error} execution={execution.state} contextMatches={execution.contextMatches} submissionPlan={submissionPlan.current} />
      <section className="stack" aria-label={t('transfer.title')}>
        <Card title={t('transfer.title')} aside={<span className="muted small">{t('transfer.flow')}</span>}>
          {holdings.error && <ErrorState title={t('ux.balancesUnavailable')} onRetry={() => void holdings.refetch()} />}
          {partialHoldings && <ErrorState title={t('ux.balancesPartial')} onRetry={() => void holdings.refetch()} />}
          <form onSubmit={(e) => void submit(e)} noValidate>
            <div className="form-row">
              <Field label={t('transfer.asset')}>
                <select disabled={formLocked} value={form.asset} onChange={(e) => update({ asset: e.target.value })}>
                  {deployment.assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.symbol})
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={t('transfer.from')}
                error={errors.from}
                hint={balanceHint(form.from)}
              >
                <select disabled={formLocked} value={form.from} onChange={(e) => update({ from: e.target.value })}>
                  {deployment.wallets.map((w) => (
                    <option key={w.address} value={w.address}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('transfer.to')} error={errors.to} hint={balanceHint(form.to)}>
                <select disabled={formLocked} value={form.to} onChange={(e) => update({ to: e.target.value })}>
                  {deployment.wallets.map((w) => (
                    <option key={w.address} value={w.address}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('transfer.amount')} error={errors.amount}>
                <input disabled={formLocked} type="text" inputMode="numeric" value={form.amount} onChange={(e) => update({ amount: e.target.value.trim() })} />
              </Field>
            </div>
            <div className="actions">
              <button type="submit" className="primary" disabled={formLocked}>
                {planning && <Spinner />} {t('transfer.plan')}
              </button>
            </div>
            <p className="small muted">{t('transfer.note')}</p>
          </form>
          {preparation.error && <p className="warn-text" role="alert">{t('operations.prepareFailed')}</p>}
          {!plan && execution.state.error && <ReasonList reasons={[execution.state.error]} showDetail />}
        </Card>

        {plan && (
          <section aria-label={t('ux.stepReview')}>
            <h3>{t('ux.stepReview')}</h3>
            <PlanReview
              plan={plan}
              signerLabel={labelFor(deployment, form.from)}
              signLabel={t('transfer.sign', { wallet: labelFor(deployment, form.from) })}
              execution={execution.state}
              onSign={sign}
            />
          </section>
        )}
      </section>

      {plan && (
        <details open={blocked || execution.state.phase === 'error' || execution.state.evidence?.status === 'failed' || execution.state.evidence?.status === 'unknown'}>
          <summary>{t('transfer.diagnosis')}</summary>
          <div className="grid-2">
            <PartyCard title={t('transfer.from')} snapshot={plan.diagnostics.source} />
            <PartyCard title={t('transfer.to')} snapshot={plan.diagnostics.destination} />
          </div>
        </details>
      )}

      {execution.state.evidence && (
        <Card title={t('transfer.result')}>
          {!execution.contextMatches && <p className="small warn-text">{t('ux.retainedEvidence')}</p>}
          {!plan && <p className="small muted">{t('evidence.recheckNote')}</p>}
          {execution.displayMetadata && <p className="small muted">{t('receipts.deployment')}: {execution.displayMetadata.deployment.generatedAt}</p>}
          <EvidenceView evidence={execution.state.evidence} decimals={execution.displayMetadata?.decimals ?? asset.decimals} labelOf={(a) => labelFor(execution.displayMetadata?.deployment ?? deployment, a)} onRecheck={() => void execution.recheck()} rechecking={execution.state.phase === 'verifying'} contextMatches={execution.contextMatches} persistenceWarning={execution.journalError} />
        </Card>
      )}
    </div>
  )
}
