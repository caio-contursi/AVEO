# Pendências do backend (levantadas pelo front)

O front (`app/`) foi feito sem mudar nada do backend: `programs/`, `packages/`, configurações, dependências e o `Cargo.lock` estão como na `main`. Tudo o que está abaixo apareceu ao integrar e testar o Desk contra o validador local. **Nada aqui foi corrigido no backend.** Cada item traz a descrição, a rota ou instrução afetada, uma sugestão e o que o front faz hoje.

Ambiente dos testes (02/10/2026): localnet via Docker (`app/dev/solana`), Agave 2.3.0, `aveo-hook` compilado do código atual com platform-tools v1.53 e carregado em `ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33`, SAS e Token-2022 copiados da devnet. As contas da demo foram criadas por `pnpm fixtures`: SAS, mints, políticas e carteiras sintéticas.

## Resumo

| # | Pendência | Afeta | Como o front lida hoje |
|---|---|---|---|
| 1 | Programa sem deploy, sem IDL versionada, sem manifest | todas as instruções; `config/` | lê um manifest próprio (`VITE_DEPLOYMENT_URL`); em localnet, gerado pelos fixtures |
| 2 | Camada off-chain vazia (sas-client, backend-aveo, scripts, tests) | inspect/plan/verify, scan, histórico | implementa a rota B no navegador; histórico de incidentes em **MOCK** (localStorage); fixtures e cenário só de desenvolvimento |
| 3 | Sem binding, o bloqueio fora da UI não chega ao hook | `set_binding`, `execute` | diagnóstico explica com uma dica; transferência fica bloqueada antes de assinar |
| 4 | `update_policy` não autorizado devolve `PolicyMissingOrInactive` | `update_policy`, `init_extra_metas` | só mostra o editor para o `issuer_authority` conectado |
| 5 | Renovação é por mint; incidente afeta vários | `RenewBindingCapable` | um plano e uma assinatura por ativo |
| 6 | Nome SAS acima de 32 bytes deriva PDA diferente do SAS | `require_live_eligibility` | nomes curtos nos fixtures; sem impacto hoje |
| 7 | Instalação só documentada para Linux/macOS | README raiz | ambiente Docker em `app/dev/solana` |
| 8 | Medição de compute units não registrada | spec v3 | valores medidos abaixo |
| 9 | pnpm 10 ignora o build script do esbuild | `package.json` raiz | funciona com o binário opcional; nada alterado na raiz |
| 10 | README raiz diz que `app/` está vazio | documentação | README próprio em `app/README.md` |

## 1. Programa sem deploy, sem IDL e sem manifest

**Descrição.** O `aveo-hook` não está implantado em nenhuma rede. A IDL (`target/idl/`) e a keypair do programa (`target/deploy/aveo_hook-keypair.json`) não são versionadas. A pasta `config/` com os manifests de deploy, citada no README, não existe. Sem manifest, o front não tem como saber quais mints, verificadores (credential/schema) e carteiras de demo usar. Quem clonar e rodar `anchor keys sync` também muda o `declare_id!`.

**Afeta.** Todas as instruções; `declare_id!` e `Anchor.toml`; `config/deployments.devnet.json` (inexistente).

**Sugestão.** Implantar em devnet e fixar o program ID. Versionar a IDL gerada. Publicar `config/deployments.devnet.json` sem segredos no formato que o front já lê: versão 1, com `cluster`, `programs`, `proofDomain`, `issuer`, `verifiers[]`, `assets[]` e `wallets[]` (esquema em `app/src/config/deployment.ts`).

**No front.** O manifest vem de `VITE_DEPLOYMENT_URL`, e o program ID pode ser trocado por `VITE_AVEO_PROGRAM_ID`. Em localnet, `pnpm fixtures` gera `app/.dev/deployment.json`, que o servidor de desenvolvimento serve em `/dev/deployment.json`. O validador Docker carrega o programa direto no endereço do `declare_id!` (`--bpf-program`), sem keypair.

## 2. Camada off-chain vazia

**Descrição.** `packages/sas-client`, `packages/backend-aveo`, `scripts/` e `tests/` aparecem no README e no plano, mas não existem no repositório. Com isso, faltam:

- F2: credentials, schemas e atestações SAS;
- F3: inspect/plan/verify, `scan:once` e o histórico de incidentes em SQLite;
- os scripts de bootstrap e de transferência fora da UI;
- a matriz T01–T17.

**Afeta.** O contrato `EligibilityBackend` / `RenewBindingCapable` de `packages/contracts` (spec v3, seção 7) não tem implementação no backend. Os itens 8 (incidentes) e 9 (testes) do plano também ficam sem base.

**Sugestão.** Mover para `packages/backend-aveo` a implementação que hoje está em `app/src/api/` (ela já segue o contrato) e trocar o armazenamento de incidentes por SQLite. Montar o `packages/sas-client` a partir de `app/scripts/fixtures.ts`.

**No front.** Substitutos, todos isolados e identificados:

- `app/src/api/backend.ts`: `AveoSasHookBackend` rodando no navegador. **Não é mock**: lê e simula na rede configurada e espelha a ordem de checagem do hook (`load_policy`, depois `validate_demo_mint`, `load_binding` e `require_live_eligibility`).
- **MOCK** `app/src/features/incidents/store.ts`: o histórico de incidentes fica no `localStorage` do navegador, no lugar do SQLite previsto. A tela mostra o selo "MOCK" e o aviso. Os estados e a deduplicação seguem a spec, mas o histórico não é compartilhado entre navegadores.
- **Só desenvolvimento/localnet:** `app/scripts/fixtures.ts` faz o papel do sas-client e do bootstrap com carteiras sintéticas. `app/scripts/scenario.ts` cobre `status`, `issue`, `close` e `transfer` fora da UI. Nenhum dos dois serve para devnet.
- O modo `VITE_BACKEND=mock` (dados simulados sem blockchain) **não foi implementado**, porque o validador local cobre os fluxos. `VITE_BACKEND=mpl3643` só mostra o aviso "não integrado" (gate A).

## 3. Sem binding, o bloqueio fora da UI não chega ao hook

**Descrição.** `set_binding` exige elegibilidade válida no momento (`require_live_eligibility`). Por isso, a Carteira Y, com prova do Verificador B, nunca consegue criar binding no Ativo Beta, que só aceita A. Sem binding, a conta extra do tipo PubkeyData (a PDA do binding) não existe, e o cliente Token-2022 nem consegue montar a transferência. O erro aparece no cliente, antes de chegar à rede:

```
Invalid transfer hook pubkey data: account 5EcFasfTZY7MpdZHEBhqckP1Vh72vgX7ZLVaa9w8ZWWi was not found.
```

Ou seja, a falha não vem como `ProviderPairNotAllowed` (6005) do hook. A spec (T02) espera o motivo "Beta não aceita provas do Verificador B" também fora da UI. O mesmo vale para Z em Beta, onde falta o fato exigido (`RequiredFactMissing`).

Reproduzido em 02/10/2026: `pnpm scenario transfer beta X Y 1` → `RECUSADA ... MissingExtraAccounts`.

**Afeta.** `set_binding`; `execute` com as extra metas do binding; qualquer transferência envolvendo carteira sem binding.

**Sugestão** (decisão da equipe do programa):

- (a) Aceitar e documentar que, sem binding, o motivo exato vem do diagnóstico. O hook continua bloqueando, só que antes, no cliente.
- (b) Permitir `set_binding` de uma prova que só confere titular e SAS, sem exigir que o par seja aceito. Assim o `execute` passa a devolver 6005 ou 6012 on-chain.

**No front.** O diagnóstico mostra `BindingMissing` e, como dica marcada, `ProviderPairNotAllowed` ("Ativo Beta não aceita provas do Verificador B") ou `RequiredFactMissing`. A transferência fica bloqueada antes de assinar, com `MissingExtraAccounts` e o detalhe da conta que falta.

## 4. `update_policy` não autorizado devolve `PolicyMissingOrInactive`

**Descrição.** Em `programs/aveo-hook/src/lib.rs`, `UpdatePolicy` e `InitExtraMetas` usam `has_one = issuer_authority @ AveoError::PolicyMissingOrInactive`. Quem tenta alterar a política sem ser o emissor recebe "política ausente ou inativa", o que confunde: a política existe e está ativa.

**Afeta.** `update_policy` e `init_extra_metas` (código 6001).

**Sugestão.** Acrescentar `UnauthorizedIssuer` **no fim** do enum, como 6015. Assim os códigos 6000–6014 não mudam e o front e os testes continuam válidos. Incluir o novo erro em `ONCHAIN_ERRORS` (`packages/contracts`).

**No front.** O editor de política só aparece com o `issuer_authority` conectado, e a assinatura só é liberada para ele. Se o código vier assim mesmo, o front mostra `PolicyMissingOrInactive`, como o programa devolve.

## 5. Renovação por mint num incidente com vários ativos

**Descrição.** `RenewBindingCapable.planRenewBinding` recebe um único `mint`. Quando a prova de X vence, o incidente afeta Alfa e Beta. A correção, então, exige duas transações e duas assinaturas da carteira.

**Afeta.** O contrato `RenewBindingCapable` em `packages/contracts`.

**Sugestão.** Aceitar `mints: string[]` e montar uma transação só, com um `set_binding` por mint. Cabe com folga: cerca de 21 mil CU cada.

**No front.** Um plano por ativo afetado, simulados juntos e assinados em sequência pelo titular. O incidente só resolve depois de uma leitura nova com todos os ativos elegíveis.

## 6. Nome de credential/schema com mais de 32 bytes

**Descrição.** Segundo o `sas-lib` 1.0.10 (`dist/src/pdas.js`), o SAS usa só os 32 primeiros bytes do nome na seed das PDAs de credential e schema. Já o hook (`programs/aveo-hook/src/sas.rs`, `derive_address`) usa o nome inteiro. Com um nome acima de 32 bytes, a derivação no hook diverge ou falha (seed longa demais), e uma prova válida seria recusada.

**Afeta.** `execute` e `set_binding`, na checagem de coerência das PDAs SAS dentro de `require_live_eligibility`.

**Sugestão.** Truncar o nome para 32 bytes em `derive_address`, como o SAS faz, ou limitar o tamanho no bootstrap. Nos dois casos, cobrir com um teste.

**No front.** Os fixtures usam nomes curtos. Sem impacto hoje.

## 7. Instalação só para Linux/macOS

**Descrição.** O README raiz só traz a instalação para Linux e macOS. No Windows, `cargo build-sbf` e o validador exigem WSL2 ou Docker.

**Sugestão.** Documentar a rota para Windows. O front já traz `app/dev/solana`: uma imagem Docker que compila o programa (`cargo build-sbf --tools-version v1.53 -- --locked`, com o repositório montado só para leitura) e sobe o validador, sem instalar Rust ou Solana no host. As ferramentas ficam numa pasta configurável (`AVEO_DEV_HOME`).

## 8. Medição de compute units

A spec pede o registro. Valores medidos no localnet em 02/10/2026:

| Operação | CU |
|---|---|
| Transferência Token-2022 com o hook (simulação, X→Y 1 ALFA) | 73.596 |
| `set_binding` (execução confirmada, Alfa e Beta) | 20.920–20.921 |
| `set_binding` (simulação) | 21.070–21.071 |

O front envia com limite de CU igual ao consumo simulado × 1,3.

**Sugestão.** Registrar no README e nos testes on-chain, junto com `execute` em cada caso de falha.

## 9. pnpm 10 e build scripts de dependências

**Descrição.** O pnpm 10 não roda build scripts sem allowlist e avisou sobre o `esbuild`, dependência do Vite. Tudo funciona, porque o esbuild usa o binário opcional da plataforma, mas a raiz não tem `pnpm.onlyBuiltDependencies`.

**Sugestão.** Acrescentar `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` no `package.json` raiz.

**Nota.** O único arquivo fora de `app/` alterado pelo front é o `pnpm-lock.yaml`. Ele ganhou o importer `app`, membro já previsto em `pnpm-workspace.yaml`. Os importers do backend não mudaram; as entradas `typescript@5.6.3` só mudaram de posição na ordem alfabética.

## 10. README raiz desatualizado

**Descrição.** A tabela "Estado atual" do README raiz ainda diz que `app` está vazio. Ela também lista pacotes que não existem (item 2).

**Sugestão.** Atualizar a tabela quando o backend absorver as partes do item 2. O front não alterou o README raiz, para não mexer na documentação do backend. As instruções do Desk estão em `app/README.md`.
