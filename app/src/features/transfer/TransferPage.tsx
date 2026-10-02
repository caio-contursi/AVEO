import { useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import type { DeskPlan } from '../../api/backend'
import type { DeskSnapshot } from '../../api/diagnostics'
import { useReadyDesk } from '../../app/desk'
import { formatAmount } from '../../components/format'
import { ReasonList } from '../../components/reasons'
import { Card, Field, Spinner, VerdictBadge } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { useWallet } from '../../wallet/context'
import { useHoldingsQuery } from '../assets/queries'
import { EvidenceView } from '../operations/EvidenceView'
import { labelFor } from '../operations/labels'
import { PlanReview } from '../operations/PlanReview'
import { useExecutePlan } from '../operations/useExecutePlan'

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
      {snapshot.reasons.length === 0 ? <p className="small ok-text">{t('detail.allGood')}</p> : <ReasonList reasons={snapshot.reasons} />}
    </Card>
  )
}

export function TransferPage() {
  const { t, locale } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const { connected } = useWallet()
  const holdings = useHoldingsQuery()
  const execution = useExecutePlan()
  const investor = deployment.wallets.find((w) => w.role === 'investor') ?? deployment.wallets[0]!
  const [form, setForm] = useState<FormState>({
    asset: deployment.assets[0]!.id,
    from: investor.address,
    to: deployment.wallets.find((w) => w.address !== investor.address)!.address,
    amount: '1',
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [plan, setPlan] = useState<DeskPlan>()
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<unknown>()

  // Ao conectar uma carteira do manifest, ela vira a origem sugerida.
  useEffect(() => {
    if (connected && deployment.wallets.some((w) => w.address === connected.address)) {
      setForm((f) => (f.from === connected.address ? f : { ...f, from: connected.address }))
    }
  }, [connected, deployment.wallets])

  const asset = deployment.assets.find((a) => a.id === form.asset)!
  const balanceOf = (wallet: string) => holdings.data?.holdings.find((h) => h.mint === asset.mint && h.wallet === wallet)?.amount

  const update = (patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch }))
    setPlan(undefined)
    execution.reset()
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
    setPlanning(true)
    setPlanError(undefined)
    execution.reset()
    try {
      setPlan(await backend.planTransfer({ cluster: ctx.cluster, mint: asset.mint, sourceOwner: form.from, destinationOwner: form.to, amount }))
    } catch (error) {
      setPlanError(error)
    } finally {
      setPlanning(false)
    }
  }

  const sign = () => {
    if (!plan) return
    const before = [balanceOf(form.from), balanceOf(form.to)]
    void execution.execute(plan, { balancesBefore: before.every((b) => b !== undefined) ? (before as bigint[]) : undefined })
  }

  return (
    <div className="stack">
      <Card title={t('transfer.title')} aside={<span className="muted small">{t('transfer.flow')}</span>}>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <div className="form-row">
            <Field label={t('transfer.asset')}>
              <select value={form.asset} onChange={(e) => update({ asset: e.target.value })}>
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
              hint={balanceOf(form.from) !== undefined ? t('transfer.balance', { amount: formatAmount(locale, balanceOf(form.from)!, asset.decimals) }) : undefined}
            >
              <select value={form.from} onChange={(e) => update({ from: e.target.value })}>
                {deployment.wallets.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('transfer.to')} error={errors.to}>
              <select value={form.to} onChange={(e) => update({ to: e.target.value })}>
                {deployment.wallets.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('transfer.amount')} error={errors.amount}>
              <input type="text" inputMode="numeric" value={form.amount} onChange={(e) => update({ amount: e.target.value.trim() })} />
            </Field>
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={planning}>
              {planning && <Spinner />} {t('transfer.plan')}
            </button>
          </div>
          <p className="small muted">{t('transfer.note')}</p>
        </form>
        {planError !== undefined && <ReasonList reasons={[{ code: 'ReadUnverifiable', message: planError instanceof Error ? planError.message : String(planError) }]} showDetail />}
      </Card>

      {plan && (
        <>
          <h3>{t('transfer.diagnosis')}</h3>
          <div className="grid-2">
            <PartyCard title={t('transfer.from')} snapshot={plan.diagnostics.source} />
            <PartyCard title={t('transfer.to')} snapshot={plan.diagnostics.destination} />
          </div>
          <Card>
            <PlanReview
              plan={plan}
              signerLabel={labelFor(deployment, form.from)}
              signLabel={t('transfer.sign', { wallet: labelFor(deployment, form.from) })}
              execution={execution.state}
              onSign={sign}
            />
          </Card>
        </>
      )}

      {execution.state.evidence && (
        <Card title={t('transfer.result')}>
          <EvidenceView evidence={execution.state.evidence} decimals={asset.decimals} labelOf={(a) => labelFor(deployment, a)} />
        </Card>
      )}
    </div>
  )
}
