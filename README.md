# Aveo Compliance Desk

Prova de conceito para o hackathon Colosseum (Superteam BR): uma atestação SAS sintética reutilizada em dois tokens Token-2022, cada um com sua política, aplicada on-chain por um Transfer Hook. Um Desk mostra os incidentes de elegibilidade e acompanha a correção.

> Provas sintéticas; demo devnet; sem KYC real.

Planos: [`docs/plano-execucao.md`](docs/plano-execucao.md) (completo) e [`docs/algoritmo-execucao.md`](docs/algoritmo-execucao.md) (versão simplificada).
Contrato entre equipes: [`docs/interface-v2.md`](docs/interface-v2.md).

## Estado atual

| Parte | Estado |
|---|---|
| `programs/aveo-hook` | Policy, binding, extra metas e `execute`. `set_binding` confere titular e SAS; o `execute` recusa par não aceito (`6005`) e fato ausente (`6012`). Signer que não é o emissor recebe `UnauthorizedIssuer` (`6015`) |
| `packages/contracts` | Tipos e erros compartilhados, inclusive renovação de vários mints numa transação |
| `packages/sas-client` | Corte do nome SAS em 32 bytes, igual ao sas-lib e ao hook |
| `packages/backend-aveo` | Mints da renovação, regra de incidente e histórico SQLite do `scan:once` |
| `packages/backend-mpl` | Esqueleto que responde `BackendNotIntegrated` (rota A, até o gate A) |
| `app/` | Desk. O diagnóstico, o plano e a verificação rodam no navegador, sobre o RPC |
| `config/programs.json` | IDs fixos do hook, do SAS e do Token-2022. Mints da demo saem do `pnpm fixtures`, não de um manifest inventado |

O programa **não está implantado em devnet**. O ID `ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33` está fixado no `declare_id!` e no `Anchor.toml`. A keypair correspondente não está no Git. Não rode `anchor keys sync`: isso trocaria o ID. A demo local carrega o `.so` compilado nesse endereço.

### Compute units (localnet, 02/10/2026)

| Operação | Compute units |
|---|---|
| Transferência Token-2022 com o hook (simulação, X → Y, 1 ALFA) | 73.596 |
| `set_binding` confirmado (Alfa e Beta) | 20.920–20.921 |
| `set_binding` simulado | 21.070–21.071 |

Dois `set_binding` na mesma transação cabem no limite. A medição é de simulação/execução no validador local, não um teto prometido.

## Pré-requisitos (versões testadas)

| Ferramenta | Versão |
|---|---|
| Node | 22.x |
| pnpm | 10.x |
| Rust | stable (testado 1.98) |
| Solana CLI (Agave) | 2.3.0 |
| Anchor CLI | 0.32.1 |
| Solana platform-tools | v1.53 |

### Instalação do programa (Linux / macOS, com Rust e Solana na máquina)

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Linux: bibliotecas de sistema exigidas pelo Anchor
sudo apt-get install -y libudev-dev pkg-config libssl-dev

# Anchor CLI
cargo install --git https://github.com/solana-foundation/anchor --tag v0.32.1 anchor-cli --locked
```

### Windows

Não é preciso instalar Rust nem a Solana CLI. O Desk sobe o validador e compila o hook num container Docker. O passo a passo está em [`app/README.md`](app/README.md) (seção "Execução contra o validador local"). Resumo:

```bash
pnpm install
# na pasta app/, com Docker aberto e AVEO_DEV_HOME apontando para um disco com ~5 GB
pnpm solana:build
pnpm solana:validator
pnpm fixtures
pnpm demo:health  # read-only readiness before opening the Desk
pnpm dev
```

A primeira compilação baixa o Agave 2.3.0 e as platform-tools. O repositório é montado só para leitura.

## Rodando

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev                # Desk em http://localhost:5173
pnpm fixtures           # cenário local (validador já no ar)
pnpm scenario -- status
pnpm scan:once          # incidentes em app/.dev/incidents.sqlite
```

`pnpm build:program` (Linux/macOS, com a toolchain instalada) usa `cargo build-sbf --tools-version v1.53` em vez de `anchor build`, porque o compilador que vem com a Solana CLI 2.3.0 não entende dependências recentes (edition 2024). No Windows, o equivalente é `pnpm --filter @aveo/app solana:build`.

Não rode `anchor keys sync`. O program ID já está no código. A keypair de deploy não é versionada; sem ela não há deploy nesse endereço em devnet.

## Automated local acceptance

Use Node 22 or later. With the local validator running, generate the synthetic
fixtures and run the acceptance checks without opening the Desk:

```bash
pnpm fixtures
pnpm demo:check
pnpm demo:report  # reruns the checks and writes a public JSON receipt
pnpm demo:faults  # read-only faults/recovery, after a passing current demo:report
pnpm demo:http-faults  # the same workflow through an ephemeral loopback HTTP server
```

`demo:check` checks shared proof reuse, successful transfers, the Alfa/Beta policy
differences, issuer and binding authorization, authorized SAS close, rejected
inbound/outbound transfers with unchanged token balances, grouped incidents, and
wallet-signed renewal across both assets in one transaction. It also removes a
provider from Alfa without affecting Beta, temporarily deactivates Alfa, and
waits for an actual short-lived proof to expire against the validator clock.
Policies and bindings are restored after these checks. Expected failures
are submitted with preflight disabled only in this local runner, so their
signatures and hook errors are recorded in the ledger. It prints `PASS`, `FAIL`,
`NOT_RUN`, and public transaction evidence; any failed expectation returns a
nonzero exit status. Failed transactions still consume synthetic SOL fees.

The false-KYC core of T04 uses a real verifier-A SAS attestation with KYC false,
accreditation true, the correct subject/domain and a live validator-Clock expiry.
Both active policies must require KYC. X signs bindings to this shared proof in
Alfa and Beta; coherent observations must identify KYC as the sole blocking fact.
Four submitted ledger transfers (inbound/outbound on each asset) must fail with
`RequiredFactMissing` and unchanged token balances. A `finally` block restores
the original eligible bindings before closing the temporary proof. The public
report retains only typed synthetic fact flags, addresses, slots and signatures.
These three stages do not complete T04's missing-binding/proof cases: T04 stays
`NOT_RUN`, even when the false-KYC stages pass. This does not claim real KYC checks.

T15 persists the actual grouped incident produced by closing X's shared proof.
It writes an isolated SQLite database in one Node process, then reloads it in a
different process and reapplies the same recorded observations. Incident
identities, lifecycle state, grouped mints, watched proofs and event history must
remain unchanged, without duplication or an invented resolution. Replaying these
observations is not a fresh blockchain scan and never authorizes a transfer.
The temporary database is separate from the operator's `scan:once` history and
is removed after the check; only allowlisted public evidence enters the report.
The round trip must be exact, including bigint values; an unsupported JSON shape
such as an explicit `undefined` property fails rather than claiming persistence.
Worker errors and deadlines cannot approve T15. Deadline/cleanup ordering is
covered with controlled process events; successful restarts and a missing-database
failure use actual Node processes and SQLite. This does not test an OS crash
during a write or promise production high availability.

The runner also exercises an external Token-2022 client without a Desk plan:
with official extra-account resolution the valid transfer succeeds; without the
extra accounts it fails in the ledger without changing balances; with complete
accounts but an expired proof the hook rejects it. All three checks are required
before the receipt marks T11 `PASS`. Expected missing-account failures need a
specific ledger error and matching program logs, not just any failed request.

T12 adds a fresh synthetic delegate, with no Aveo binding or SAS proof. X grants
it a 10-token spending allowance. The delegate signs a transfer, but the hook
checks X, the token account owner, not the signer. A successful transfer consumes
one token and one unit of allowance. After X's proof expires, the delegated
transfer fails with `AttestationExpired`; neither balances nor allowance change.
X revokes the temporary approval in a `finally` cleanup and the runner verifies
that no delegate or allowance remains. The delegate never receives issuer powers.

T13 invokes SPL Transfer Hook Execute directly with the complete official
account list. It must fail in the real ledger with `NotTransferContext`, because
Token-2022 has not marked the accounts as transferring; all protected accounts
remain unchanged. Separate policy and binding tests sign a valid, distinct fee
payer but deliberately omit the required authority signature. Only the canonical
validator signature-verification error is accepted. These packets are rejected
before execution: they have no ledger confirmation, and their evidence slots
describe unchanged account reads, not transaction confirmations.

T16 uses raw Token-2022 instructions for zero, exact available balance, one above
the available balance and maximum u64 (an unsigned 64-bit token amount). The two
oversized transfers must fail in the ledger with the specific Token-2022
`InsufficientFunds` error and unchanged balances. It also transfers between two
distinct token accounts owned by the treasury, validating conservation and the
actual owner. The exact-balance transfer is returned by X; a `finally` cleanup
returns auxiliary tokens, closes the temporary account and checks original token
balances. If a submitted signature remains unknown, cleanup must not replay a
transfer: the run fails explicitly rather than risking a duplicate operation.
This sizing uses the existing TransferHook-only fixture mint, not arbitrary mints.

`demo:report` writes `app/.dev/acceptance-report.json`, an ignored runtime artifact
with timestamps, ordered stage results, public signatures, slots and balances.
Only explicitly allowed evidence fields are saved, never raw process logs,
RPC URLs or private keys. The receipt maps covered scenarios to T01–T17 and
marks incomplete matrix cases `NOT_RUN`; a passing run is not a passing full
security matrix. A failed or interrupted runner cannot produce a passing receipt.
Each execution replaces the previous receipt. These synthetic localnet receipts
are demonstration evidence, not independent attestations or devnet explorer links.

`demo:faults` requires a passing receipt from the current fixture generation and
matching mints, plus an actual confirmed external-transfer signature. It reads
the real local validator and injects unavailable reads, account/confirmation
timeouts and below-minimum slots at the SDK boundary. It checks that diagnoses
remain `unknown`, grouped incidents stay unresolved, suspended requests abort,
and the same signature can be confirmed later without signing or sending again.
Only a complete fresh eligibility readback can resolve the read-unverifiable
incident. This runner holds no wallet keys, blocks transaction submission and
records zero send calls throughout the successful seven-stage workflow.

Its separate ignored `app/.dev/fault-report.json` maps these core checks to T14.
This is controlled SDK fault injection, not an HTTP outage, browser interaction
test or independent network attestation. The two receipts are not merged: T14
remains `NOT_RUN` in `acceptance-report.json`, and unrelated matrix cases remain
`NOT_RUN` in `fault-report.json`. No single receipt claims the complete matrix.

`demo:http-faults` repeats that same seven-stage workflow with an actual HTTP
transport, not a mocked SDK method. An ephemeral server listens only on
`127.0.0.1`, forwards explicit read/simulation methods to the local validator,
returns controlled HTTP 503 responses, holds requests until the client cancels
their connections, and rewrites only an observation slot for the stale-read case.
It blocks transaction submission, airdrops, unknown methods and batches, refuses
credential-bearing or non-loopback upstreams and never follows HTTP redirects.
Healthy upstream JSON is preserved verbatim to avoid rounding large integer
values. The server closes its connections on success or failure.

The ignored `app/.dev/http-fault-report.json` identifies `http-loopback` transport;
the SDK receipt identifies `sdk-injected`. Each independently covers T14's core
workflow with zero sends. These are controlled local transport failures, not
public-RPC load testing, browser-wallet testing or evidence of devnet readiness.
The three independent reports are not merged into a full security-matrix claim.

### Read-only demonstration readiness

`pnpm demo:health` checks the current synthetic localnet state without reading
wallet keys, simulating, signing or sending a transaction. Six stages require
the supported executable programs; current eligible treasury/X bindings in
Alfa and Beta; at least two minutes of proof validity against the validator
Clock; one shared proof per subject across both assets; positive initialized
Token-2022 accounts with correct owners/mints; and no leftover delegate approval.
Run it after fixtures, and again after acceptance to check the restored state.

The ignored `app/.dev/health-report.json` contains allowlisted public observations.
Unknown, stale, blocked or incomplete reads produce a failed report and nonzero
exit status, never a readiness success. It is a point-in-time observation, not a
promise that a later transfer will succeed, an automatic repair or a security
matrix approval. All T01–T17 entries stay `NOT_RUN` in this separate health report.

The acceptance runner (`demo:check`/`demo:report`) changes synthetic localnet state:
it closes X's proofs and creates a
replacement. Regenerate fixtures to restore the original demonstration scenario.
It requires loopback RPC/WebSocket endpoints and a localnet manifest, and does
not deploy programs or authorize use with real assets. A loopback URL alone does
not verify which network a proxy forwards to; use the project's local validator.

```bash
pnpm demo:check --self-test  # checks runner assertions without a validator
pnpm typecheck
pnpm test
pnpm --filter @aveo/app lint
pnpm --filter @aveo/app build
cargo test -p aveo-hook --locked
```

The Rust tests exercise validation functions with account fixtures. The acceptance
runner exercises the deployed local programs. Neither alone proves every scenario
in the T01–T17 matrix or an official MPL-3643 integration.

Local verification on 2026-10-09 used Node 22, Agave 2.3.0 and platform-tools
v1.53: 23 Rust tests passed with the SBF build in the first readiness round.
The second round passed 137 app/script tests, 4 backend tests, the 21-stage
acceptance runner and receipt generation, TypeScript checks, ESLint and the
frontend build. It did not change the Rust program or repeat its earlier build.
The third round passed 223 app/script tests and 4 backend tests, production and
test-project TypeScript checks, ESLint and the frontend build. The 21-stage local
acceptance run remained passing after coherent-readback and bounded-read changes.
The fourth round passed 265 app/script tests and 4 backend tests, the same type,
lint and frontend build checks, and the expanded 24-stage acceptance run. Public
receipt recovery was also tested across two separate Node processes against a
real localnet signature: confirmation succeeded with zero transaction sends.
The fifth round passed 336 app/script tests and 4 backend tests, production and
test-project TypeScript checks, ESLint, frontend build and runner self-tests.
The real local acceptance run passed all 27 stages, including T12 owner-based
delegate checks and approval cleanup. The separate seven-stage SDK fault and
read-only recovery run passed, including T14's core workflow with zero sends.
This round did not change or rebuild the Rust program or add dependencies.
The sixth round passed 420 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint, frontend build and runner self-tests. Its expanded real local acceptance run
passed all 36 stages, adding T13 authority and direct-hook checks and T16 boundary
and same-owner checks. Both the SDK and actual loopback HTTP recovery workflows
passed seven stages independently, with zero sends. No Rust program or dependency
was changed in this round; the earlier Rust build was not repeated.
The seventh round passed 493 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint, frontend build and runner self-tests. It adds coordinated
receipt retention/removal and read-only readiness checks. Local acceptance still
passed all 36 stages; both recovery workflows passed seven stages independently.
Readiness passed six stages before
and after acceptance. Browser coordination is tested using injected locks/events,
not claimed as interactive multi-tab browser verification.
No dependencies or Rust program were changed; the earlier Rust build was not
repeated in this round.
The eighth round passed 567 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint, frontend build and runner self-tests. It adds bounded
visible-history export and actual-process incident persistence. Real local
acceptance passed all 39 stages, including the three required T15 stages. Both
read-only recovery workflows again passed seven stages; readiness passed six
stages before and after acceptance. No dependencies or on-chain interfaces were
changed, and the Rust build was not repeated. Clipboard lifecycle tests use
controlled callbacks/static rendering, not interactive browser verification.
The ninth round passed 718 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint, frontend build and runner self-tests. Real local
acceptance passed all 42 stages, adding the false-KYC core and explicit restoration
without approving the complete T04 matrix case. Both read-only recovery workflows
again passed seven stages; readiness passed six stages before and after acceptance.
Visible-history capacity tests cover count/byte boundaries, full versus invalid
snapshots and session-only warnings. No dependencies, Rust code or on-chain
interfaces changed; the Rust build and interactive browser tests were not run.
The tenth round passed 750 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint and the frontend build. It centralizes receipt count/UTF-8 byte limits and the near-full
threshold without sharing or weakening the independent validation schemas.
Storage, capacity, export and translated UI labels consume the same bounds.
Cross-consumer tests preserve no-eviction behavior, exact pretty-export envelope
boundaries and raw UTF-8 storage checks before unknown fields are stripped.
This round changes no dependencies, acceptance scripts or on-chain interfaces;
it does not rerun the local-validator acceptance, Rust build or browser tests.
The eleventh round passed 810 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint and the frontend build. It protects read-only plan preparation for transfer, policy
editing and proof binding. A common lifecycle discards stale replies after
form/context changes or unmount, blocks duplicate preparation synchronously,
and requires a current reviewed plan before requesting signature.
Preparation errors expose a static translated message rather than raw provider
details. These tests use controlled promises, component callbacks and static
markup, not interactive browser coverage. No dependencies, acceptance scripts,
Rust code or on-chain interfaces changed; local-validator acceptance and the
Rust build were not repeated.
The twelfth round passed 869 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint and the frontend build. It adds scoped grouped incident preparation and verification,
immediate provisional signature evidence, synchronous sign/verify guards and
interruption of unsent groups after context changes or unknown outcomes.
Controlled callback tests cover stale preparations, re-opening after a returned
signature, listener failures and retained resolution. These are not interactive
browser or cross-tab tests. No dependencies, Rust code, acceptance scripts or
on-chain interfaces changed; the local validator and Rust build were not rerun.
The thirteenth round passed 983 app/script tests and 4 backend tests, production/test
TypeScript checks, ESLint and the frontend build. It adds explicit, read-only
same-signature confirmation recovery inside incidents, with receipt/context
checks, stale-response guards and sanitized model updates. Controlled callback
and static-render tests cover disconnected wallets and concurrent actions;
these are not interactive browser or live devnet acceptance. No dependencies,
Rust code, acceptance scripts or on-chain interfaces changed; local-validator
acceptance and the Rust build were not repeated.
The fourteenth round passed 1,072 app/script tests and 4 backend tests,
production/test TypeScript checks, ESLint and the frontend build. It adds an
exact public-history export-size preview with shared canonical serialization,
translated byte-limit guidance and disabled actions for invalid/oversized
snapshots. Its 89 new unit/static-render tests include exact byte boundaries,
storage-valid but export-oversized history, privacy and both languages. These
are not interactive browser tests or live devnet acceptance. No dependencies,
Rust code or on-chain interfaces changed; validator acceptance was not rerun.
The fifteenth round passed 1,150 app/script tests and 4 backend tests,
production/test TypeScript checks, ESLint and the frontend build. It adds an
explicit native-browser public-history download with sanitized manual fallback,
current-snapshot guards and temporary resource cleanup. The 78 new tests use
fake browser APIs, controlled callbacks and static markup in both languages;
they do not establish actual file saving or interactive fallback rendering.
No dependencies, Rust code, acceptance scripts or on-chain interfaces changed;
local-validator acceptance and live devnet checks were not repeated.
The frontend build retains two existing Zod/Rollup annotation warnings; Node 22
also reports its existing experimental SQLite warning during backend tests.
These results establish local behavior, not a devnet deployment or the full
T01–T17 security matrix.

### Read-only plan preparation

`app/src/features/operations/preparation.ts` and `usePlanPreparation.ts` separate
building/simulating an intent from the existing signature/submission lifecycle.
Transfer, policy editing and proof binding share this control. Starting another
preparation clears the old review; simultaneous clicks do not start duplicate
requests. Changes to the form, connected wallet, network, program, commitment or
deployment invalidate pending replies and prepared plans. Policy editing also
tracks policy version; binding tracks the selected proof, subject, mint and
observation slot. A changed scope hides the old plan during render, before the
layout effect updates the lifecycle. Closing a screen invalidates its replies.

The operator must explicitly prepare again and review the current plan before
requesting a signature. Failed preparation produces a static English/Portuguese
alert without retaining provider errors. It never signs, sends or retries a
transaction. Changing a form still respects the execution reset guard: unresolved
submissions are not discarded. Their evidence and same-signature recheck remain
managed by the separate existing execution lifecycle.

Invalidating preparation does not abort a read/simulation already issued to the
RPC, make an earlier observation current, or guarantee a future transfer.
On-chain checks remain authoritative. Grouped incident preparation and manual
eligibility verification also use scoped lifecycles; actual browser lifecycle
tests remain pending.

### Grouped incident renewal safety

`app/src/features/incidents/renewal.ts` groups candidates by proof, preserving
order and deduplicating repeated mints. Conflicting proof choices for one mint
reject the preparation rather than producing overlapping actions. The card
tracks context, wallet, incident identity/affected assets, candidate proofs and
policy versions. A late reply cannot mark an obsolete incident prepared.
Changing `open` to `action-prepared` does not invalidate its own current review.
Sign/verify have a synchronous, card-local lock in addition to disabled buttons.

Each returned signature is immediately recorded as provisional `unknown`
evidence in the captured incident store and separately captured by the public
receipt journal, before confirmation completes. Later same-signature evidence
replaces that provisional entry without duplicating the signed event; unrelated
evidence remains. Late submission outcomes never demote a resolved incident.
An exception in receipt recording cannot interrupt verification of an already
submitted transaction. Store-listener errors do not leave the card lock stuck.

Before each group, the card checks that the reviewed batch is still current.
Navigation/context changes stop groups not yet submitted; they cannot cancel
an existing wallet request or transaction. Unknown verification also stops the
remaining groups. Evidence for already submitted groups is retained in their
original store even after leaving the card. Pending confirmation or any current
unknown evidence blocks another renewal; manual eligibility verification remains
available and still requires complete, fresh eligible readback to resolve.

This is deliberately conservative: querying a receipt in the separate Receipts
tab does not update incident confirmation evidence. The incident's dedicated
same-signature action, described below, can update it without resubmission.
The signature-based guard begins only after a real
signature returns, not while the wallet prompt is pending. It is not a global or
cross-tab signing lock, and incident storage still has its existing best-effort
browser persistence behavior. Invalidating a read does not abort its RPC request.

### Recovering an incident's original confirmation

An unresolved incident with a unique, valid unknown signature offers **Query
original signature**. This is an explicit read-only action, available without
a connected wallet. `confirmation-recovery.ts` requires exactly one corresponding
public receipt, checks its cluster/program/commitment/fixture/RPC fingerprint
against the selected context, and requires that the same receipt object remain
present during the request. Missing, removed, replaced or duplicated receipts,
context changes and navigation discard the reply without changing the incident.
Only confirmed/finalized contexts are supported; processed receipts cannot be
promoted by this action. Confirmation uses the existing bounded RPC reader with
a 15-second deadline. A failure to establish a terminal result remains `unknown`.

`confirmation-model.ts` replaces only the matching still-unknown evidence entry,
requires a safe fresh slot for terminal results, and rechecks the incident
identity/affected assets against current store data. Other evidence and signed
events remain; a separate `rechecked` event records the consultation. Provider
messages, raw logs, readbacks and balances are not copied into recovered evidence.
The UI reports the last recorded consultation, not an automatic authorization.

Confirmed signatures leave the incident awaiting independent eligibility
verification; they never resolve it or reconstruct a plan. A failed signature
can return an incident to open only when no other pending/confirmed signature
still requires verification. Unknown results continue to block another renewal.
After confirmation, **Verify eligibility** still needs complete, fresh eligible
observations for every affected asset. The separate Receipt tab remains read-only
and does not update incident state.

Browser receipts and incident metadata remain untrusted. Scope matching is not
cryptographic network identification, and RPC confirmation of a recorded
signature does not prove that its transaction renewed this incident's bindings.
On-chain validation and fresh eligibility remain authoritative. A missing receipt
leaves recovery blocked rather than guessing the original context. There is no
transaction reconstruction, automatic resend, receipt import or wallet access.

Transaction confirmation now honors the selected commitment (the requested
level of agreement on a transaction), with a single deadline covering status
requests, log requests and polling. Requests are aborted at the deadline, and
timeouts return `unknown`, never success or an automatic transaction resend.
If logs are unavailable for a confirmed failure, the result remains a failure
without inventing a specific hook error. These RPC failure modes are covered by
unit tests and the controlled SDK and loopback HTTP acceptance workflows described
above, not claimed as browser end-to-end or public-network T14 coverage.

Account reads have a 10-second deadline, cancel their pending request and reject
invalid or stale slots and incomplete account lists. Eligibility inspection uses
its first read to discover proof addresses, then rereads policy, mint, binding,
Clock and SAS accounts together. The final decision uses only this shared
observation slot, including the final policy version and chain timestamp. A
binding replaced during discovery returns `unknown`; inspect again rather than
combining the replacement with the previous proof. Display-only proof reads do
not advance the observation slot of a rejected-provider policy decision.

For transfer, binding and policy operations, an unknown submitted transaction
offers **Recheck confirmation** (Portuguese: **Verificar novamente**). This action
only verifies the retained signature using its original plan and backend; it
does not sign or send a new transaction and works with the wallet disconnected.
Evidence labels and decimal precision remain those of the submitted asset,
not a subsequently edited form or a different deployment.
Concurrent actions and resetting an unresolved submission are blocked. Network,
RPC, program, commitment or deployment changes disable rechecking and suppress
links to the wrong network's Explorer. Restore the original context to recheck.
The original plan and detailed readback remain in component memory only; leaving
the component loses that operation's in-memory recovery state.
Controller and static-render tests cover these protections; they do not replace
interactive browser testing. A separate live localnet recheck confirmed a
previously submitted transfer, returned two fresh readbacks and made no send calls.

### Public signature recovery after reload

The **Public submission receipts** tab (`#/recibos`) stores signatures from Desk
transfers, binding changes, policy updates and grouped incident renewals in this
browser's `localStorage`. Its receipts contain only a signature, recorded time,
cluster, program, commitment, fixture generation and SHA-256 RPC fingerprint.
No wallet key, RPC URL, unsigned transaction, plan, payload, log or cached
confirmation is stored. Query the same signature after navigation/reload without
a wallet; the receipt is never a request that can be signed or resent.

Confirmation is queried manually, against a matching original context, and kept
only for the current history page. Context changes clear old results and prevent
wrong-network Explorer links. Browser metadata is untrusted and matching an RPC
fingerprint does not prove the network identity or turn the history into an
authorization source. Receipt confirmation does not resolve incidents by itself;
their separate complete, current eligibility readback remains required.

Each receipt offers **Copy public receipt** and **Export JSON for manual copy**,
with English/Portuguese feedback. Export uses an independent validated allowlist
and a versioned `aveo-public-submission-receipt` envelope, never including RPC
URLs, plans, raw logs or cached confirmation claims. Copy/export is user-triggered
and needs no RPC response or wallet, even when the current context does not match.
If clipboard access is unavailable or denied, a read-only text area exposes the
same validated JSON for manual copy. Exported metadata remains untrusted; there
is no import, transaction reconstruction or authorization from this JSON.

**Copy visible public history** and **Export visible history for manual copy** export one
snapshot of the currently visible local receipts, including session-only entries.
The versioned `aveo-public-submission-history` envelope preserves receipt order
and independently strips unknown fields from every entry. Any invalid or duplicate
receipt rejects the entire export, never silently skipping a record. The readable
JSON is bounded to 100 receipts and 128,000 UTF-8 bytes, including its envelope.
An empty history disables all grouped export actions in the UI.

**Download visible public history (JSON)** requests a local file named
`aveo-public-submission-history.json` using the same validated, bounded envelope.
`app/src/features/operations/receipt-download.ts` uses a temporary JSON Blob URL
and checks the requesting snapshot before triggering the browser. It removes
the temporary link and releases the URL after a requested click; setup failures
or requests that become stale before the click release it immediately. Cleanup
failures are best effort and never cause another download. Neither the filename
nor JSON includes an RPC URL.
There is no storage mutation, network request, wallet access or import. This is
a history download only; individual receipts keep their existing copy/manual
export actions.

Feedback says **download requested**, not saved: browser policy or user choices
can prevent a file from being saved without raising an error. An observable
setup/click failure shows the same validated JSON for manual copy, never browser
error details. Empty, invalid or oversized histories keep the download disabled,
with no splitting or truncation. Download can supersede pending clipboard
feedback, but cannot undo an already-started clipboard write. A changed visible
snapshot or navigation discards stale feedback; the requested file, if saved,
still describes the original snapshot. Actual browser download/save behavior is
not established by the unit and static-render tests.

These actions require no wallet, matching network context or RPC response. Denied
clipboard access exposes the same validated JSON for manual copy. Navigation,
context changes or a changed visible snapshot discard late clipboard replies and
clear old export feedback. A browser clipboard write already in progress cannot
be undone; any copied JSON describes the snapshot requested, not subsequent
changes. This is not an export of all devices/tabs, proof of confirmation, an
import format or an automatic backup. Copy/export never removes a receipt.

The journal is bounded to 100 receipts and 128,000 UTF-8 bytes, and never silently evicts one.
Shared bounds and byte measurement live in
`app/src/features/operations/receipt-limits.ts`; validation remains independent.
The compact stored array and the pretty public-export envelope have separate
serialization budgets with the same numeric limit: a valid full stored snapshot
can be too large to export as a whole. Export never silently truncates it; individual
receipt export remains available. Raw stored text is byte-checked before unknown
fields are stripped, whereas capacity and public export measure sanitized metadata.
Storage failure produces a warning and falls back to session memory; new receipts may
not survive reload. Full storage also warns rather than overwriting earlier
receipts. Clearing browser data removes this history. Signing failures before a
signature is returned cannot be captured. Interactive browser tests remain
unimplemented; Node-process recovery is not a browser test.

Browser writes use native Web Locks, a browser mechanism that lets cooperating
tabs take turns updating the same storage record. Each capture/removal rereads
and validates current storage inside that lock, preserving other tabs' receipts
instead of writing a stale snapshot. Storage events are refresh hints only;
their payload is not trusted. Session-only captures are kept separately so a
refresh does not lose them. An unrelated capture/removal never automatically
flushes other session-only receipts into storage: another tab may have saved and
removed one before this tab received a refresh hint. Pending receipts remain in
memory with a warning and should be exported before leaving. An explicit
same-signature capture can retry saving its public metadata, never resend a
transaction; there is no bulk storage-retry action in the UI.
Malformed storage or conflicting contexts are never silently overwritten.

Without Web Locks or with denied lock/storage access, new captures remain in
session memory with a warning. Previously saved receipts can still be read;
removal of persisted records is rejected when safe coordination is unavailable.
This does not synchronize different browsers/devices or protect against other
applications that modify the storage key without using the same lock.

**Remove local receipt** requires an explicit warning followed by Confirm/Cancel.
Copy/export first if you want an independent record: removing it discards this
browser's recovery metadata, not the blockchain transaction. No confirmation
query, wallet action or transaction is triggered by removal, and unknown receipts
are never deleted automatically. Failed removal keeps the receipt available;
successful removal can free capacity. Session-only receipts can be explicitly
removed from session memory. There is no automatic archive or bulk deletion.

The visible-history capacity indicator measures validated receipt count and UTF-8
bytes of the sanitized compact JSON array, including session-only receipts. It
warns at 90 receipts or 90 percent of 128,000 bytes; a measured full snapshot keeps
its counters and shows a separate full warning. Invalid/oversized snapshots or
invalid storage suppress the counters rather than suggesting available capacity.
This is not the browser's storage quota, a persistence guarantee, an all-tab view,
or the size of the pretty export envelope. A grouped export can exceed its own
byte bound even when the compact journal fits; individual receipt export remains
an independent option. Export does not free space and nothing is auto-evicted.

The history export panel also previews the exact UTF-8 size of its formatted
public backup, independently of compact-storage capacity. Preview and export
use the same canonical, allowlisted serialization in
`app/src/features/operations/receipt-export.ts`. Valid snapshots up to and
including 128,000 bytes are exportable; larger snapshots retain their measured
size and show a separate warning. Invalid metadata, duplicate signatures or
more than 100 records show no byte counter. Empty history still has a measurable
envelope, but no export action. Copy/manual-history buttons are disabled when
the snapshot is empty, invalid or too large; direct export callers still perform
their own current validation. Nothing is split, truncated or discarded, and
valid individual-receipt export remains available. Computing this preview does
not access the clipboard, wallet, RPC or browser storage, and does not guarantee
persistence or confirmation on chain.

### Proposed backlog issues

- Inspect confirmed transaction instructions and binding accounts before
  attributing a recorded signature to a particular incident renewal.
- Extract the incident action lifecycle into a focused hook so the card remains
  a presentation component without weakening its scope and no-resend guards.
- Coordinate pending incident signatures across card remounts and cooperating
  tabs, including the wallet-prompt interval, without treating local metadata as authorization.
- Thread cancellation through read-only planning so obsolete preparation can
  stop pending RPC work without altering submission or confirmation semantics.
- Extract the network adapter and incident model into shared packages so the
  Desk and CLI use the same application layer without importing frontend files.
- Share binary account fixtures between Rust and TypeScript tests to detect
  parser and diagnosis differences before they reach a demonstration or pilot.
- Add native-browser download acceptance for denied/sandboxed downloads and
  temporary URL cleanup, proving the rendered fallback textarea, availability
  during copying and byte-identical saved envelope.
- Share the exact-byte fractional-timestamp fixture across receipt tests to keep
  compact-storage and formatted-export boundary scenarios easy to maintain.
- Group the cross-consumer receipt contract tests in a documented CI gate so
  changes to storage, backup and translated operator warnings stay consistent.
- Reuse coherent-observation checks across CLI acceptance helpers so subject,
  context, fact and slot validation cannot silently diverge between scenarios.
- Exercise interrupted SQLite writes and process crashes so recovery can
  distinguish corrupt local history from an intentionally empty store.
- Add interactive browser coverage for denied clipboard permission, manual-copy
  focus and network changes while confirmation is pending, without new runtime dependencies.
- Add a real multi-tab browser test for simultaneous capture/removal, coalesced
  storage hints and denied Web Locks, proving the user-visible fallback as well
  as the storage model.
- Document the security matrix's error vocabulary next to the deployed program
  names so judging evidence cannot confuse transfer-context and signature failures.

## Estrutura

```
programs/aveo-hook/     F1 Porteiro: policy, binding, hook
packages/contracts/     tipos e erros compartilhados
packages/sas-client/    nome SAS de 32 bytes (emissão em app/scripts, via sas-lib)
packages/backend-aveo/  renovação em lote, regra de incidente, SQLite
packages/backend-mpl/   esqueleto not-integrated
app/                    Desk e scripts fixtures / scenario / scan:once
config/                 IDs dos programas, sem mints inventados
docs/                   planos, interface, threat model
config/                 manifests de deploy (sem secrets)
```
