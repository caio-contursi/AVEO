import { useState } from 'react'
import { z } from 'zod'
import type { DeskPlan } from '../../api/backend'
import type { AssetState } from '../../api/inventory'
import { useReadyDesk } from '../../app/desk'
import { Address } from '../../components/Address'
import { ReasonList } from '../../components/reasons'
import { Badge, FieldGroup, Spinner } from '../../components/ui'
import { useI18n } from '../../i18n/context'
import { useWallet } from '../../wallet/context'
import { EvidenceView } from '../operations/EvidenceView'
import { labelFor } from '../operations/labels'
import { PlanReview } from '../operations/PlanReview'
import { useExecutePlan } from '../operations/useExecutePlan'
import { usePlanPreparation } from '../operations/usePlanPreparation'

const policyFormSchema = z.object({
  credentials: z.array(z.string()).min(1).max(2),
  requireKyc: z.boolean(),
  requireAccredited: z.boolean(),
  active: z.boolean(),
})

type PolicyForm = z.infer<typeof policyFormSchema>

/** Issuer policy editing (update_policy), available to the connected issuer authority. */
function PolicyEditor({ state, onClose }: { state: AssetState; onClose: () => void }) {
  const { t } = useI18n()
  const { backend, ctx, deployment } = useReadyDesk()
  const { connected } = useWallet()
  const policy = state.policy!
  const [form, setForm] = useState<PolicyForm>({
    credentials: policy.pairs.map((p) => p.credential),
    requireKyc: policy.requireKyc,
    requireAccredited: policy.requireAccredited,
    active: policy.active,
  })
  const [error, setError] = useState<string>()
  const preparation = usePlanPreparation<DeskPlan>([
    ctx.cluster, ctx.rpcUrl, ctx.programId, ctx.commitment, ctx.deployment,
    state.asset.mint, policy.policyVersion.toString(), form, connected?.address,
  ])
  const { plan, planning } = preparation
  const execution = useExecutePlan()

  const updateForm = (update: (current: PolicyForm) => PolicyForm) => {
    if (!execution.reset()) return
    preparation.clear()
    setForm(update)
  }

  const toggle = (credential: string) =>
    updateForm((f) => ({
      ...f,
      credentials: f.credentials.includes(credential) ? f.credentials.filter((c) => c !== credential) : [...f.credentials, credential],
    }))

  const simulate = async () => {
    if (!execution.reset()) return
    const parsed = policyFormSchema.safeParse(form)
    if (!parsed.success) {
      setError(t('policy.errorPairs'))
      return
    }
    setError(undefined)
    await preparation.prepare(() => {
      const pairs = parsed.data.credentials.map((credential) => {
        const verifier = deployment.verifiers.find((v) => v.credential === credential)!
        return { credential: verifier.credential, schema: verifier.schema }
      })
      const input = {
        mint: state.asset.mint,
        authority: policy.issuerAuthority,
        args: { proofDomain: new Uint8Array(policy.proofDomain), pairs, requireKyc: parsed.data.requireKyc, requireAccredited: parsed.data.requireAccredited, active: parsed.data.active },
      }
      return backend.planUpdatePolicy(input)
    })
  }

  return (
    <div className="box">
      <strong>{t('policy.title', { asset: state.asset.label })}</strong>
      <p className="small warn-text">{t('policy.warning')}</p>
      <FieldGroup label={t('policy.verifiers')} error={error}>
        <div className="checks">
          {deployment.verifiers.map((v) => (
            <label key={v.credential}>
              <input type="checkbox" checked={form.credentials.includes(v.credential)} onChange={() => toggle(v.credential)} />
              {v.label}
            </label>
          ))}
        </div>
      </FieldGroup>
      <div className="checks" style={{ marginTop: 8 }}>
        <label>
          <input type="checkbox" checked={form.requireKyc} onChange={(e) => { const checked = e.target.checked; updateForm((f) => ({ ...f, requireKyc: checked })) }} />
          {t('policy.requireKyc')}
        </label>
        <label>
          <input type="checkbox" checked={form.requireAccredited} onChange={(e) => { const checked = e.target.checked; updateForm((f) => ({ ...f, requireAccredited: checked })) }} />
          {t('policy.requireAccredited')}
        </label>
        <label>
          <input type="checkbox" checked={form.active} onChange={(e) => { const checked = e.target.checked; updateForm((f) => ({ ...f, active: checked })) }} />
          {t('policy.active')}
        </label>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void simulate()} disabled={planning}>
          {planning && <Spinner />} {t('policy.submit')}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          {t('policy.cancel')}
        </button>
      </div>
      {preparation.error && <p className="warn-text" role="alert">{t('operations.prepareFailed')}</p>}
      {plan && (
        <PlanReview
          plan={plan}
          signerLabel={labelFor(deployment, policy.issuerAuthority)}
          signLabel={t('policy.sign')}
          execution={execution.state}
          onSign={() => { if (preparation.isCurrent(plan)) void execution.execute(plan) }}
        />
      )}
      {execution.state.evidence && <EvidenceView evidence={execution.state.evidence} decimals={execution.displayMetadata?.decimals} labelOf={(a) => labelFor(execution.displayMetadata?.deployment ?? deployment, a)} onRecheck={() => void execution.recheck()} rechecking={execution.state.phase === 'verifying'} contextMatches={execution.contextMatches} persistenceWarning={execution.journalError} />}
    </div>
  )
}

export function PolicyCard({ state }: { state: AssetState }) {
  const { t } = useI18n()
  const { deployment } = useReadyDesk()
  const { connected } = useWallet()
  const [editing, setEditing] = useState(false)
  const policy = state.policy
  const isIssuer = !!policy && connected?.address === policy.issuerAuthority

  return (
    <article className="policy">
      <header>
        <strong>{state.asset.label}</strong>
        <span className="pill">{state.asset.symbol}</span>
        {policy && <span className="muted small">{t('assets.version', { version: String(policy.policyVersion) })}</span>}
        {policy && !policy.active && <Badge tone="bad">{t('assets.inactive')}</Badge>}
      </header>
      {!policy ? (
        state.policyFailure && <ReasonList reasons={[state.policyFailure]} />
      ) : (
        <dl className="kv">
          <dt>{t('assets.accepts')}</dt>
          <dd>
            {policy.pairs.length === 0 ? (
              <span className="muted">{t('assets.noVerifier')}</span>
            ) : (
              policy.pairs.map((p) => (
                <span key={p.credential} className="chip">
                  {labelFor(deployment, p.credential)}
                </span>
              ))
            )}
          </dd>
          <dt>{t('assets.requires')}</dt>
          <dd>
            {policy.requireKyc && <span className="chip">{t('fact.kyc')}</span>}
            {policy.requireAccredited && <span className="chip">{t('fact.accredited')}</span>}
          </dd>
          <dt>{t('assets.issuer')}</dt>
          <dd>
            <Address value={policy.issuerAuthority} short />
          </dd>
          <dt>{t('status.policy')}</dt>
          <dd>
            <Address value={state.policyAddress} short />
          </dd>
        </dl>
      )}
      {isIssuer && !editing && (
        <div>
          <button type="button" onClick={() => setEditing(true)}>
            {t('assets.editPolicy')}
          </button>
        </div>
      )}
      {editing && <PolicyEditor state={state} onClose={() => setEditing(false)} />}
    </article>
  )
}
