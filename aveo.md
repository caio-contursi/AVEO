# AVEO
# Aveo Protocol - MVP técnico para Crypto World's Fair

**Status:** proposta de implementação para Bruno e Caio, 29/09/2026. Não há código Aveo no repositório consultado. **Destino:** repositório próprio do Caio, a ser informado por ele; não usar `contursi-labs`. **Prazo interno:** demo pronta até 10/10, revisão em 11/10 e submissão, se autorizada por Bruno, em 12/10. O prazo oficial de inscrição individual e submissão é 12/10/2026, 23h59 PDT (13/10, 03h59 em São Paulo). Este documento não inscreve ninguém nem autoriza publicar dados reais.

## 1. O que demonstrar

Uma instituição emissora cria um mint de **teste** Token-2022 com Transfer Hook. Sua política aceita provas de elegibilidade emitidas por **dois verificadores independentes autorizados**, mediante contas reais do Solana Attestation Service (SAS). O hook, executado pelo Token-2022 em cada transferência, deixa passar um destinatário elegível e rejeita um destinatário sem prova, com prova expirada, de verificador não autorizado ou revogada. A decisão deve persistir mesmo quando a transferência é tentada fora da interface Aveo. Nenhum documento de identidade ou KYC real entra na cadeia.

A contribuição proposta é **política por emissor que aceita múltiplos atestadores**, não a invenção de hooks, atestações ou KYC on-chain. O Civic já publicou um hook de pass; o time precisa comparar o fluxo real e não alegar exclusividade antes de testá-la. MVP em **Solana devnet**; validator local para testes reproduzíveis. Testnet só como alternativa se a implantação SAS e recursos forem confirmados lá; não prometer as duas redes.

**Fora do MVP:** verificação de identidade real, conformidade regulatória, privacidade total, dados pessoais on-chain, bridge/multichain, Zcash/Zama, Token-2022 Confidential Transfer, token econômico, painel institucional completo, migração de contas antigas, auditoria de segurança e parceria institucional. Contas e chaves de demo não guardam fundos reais.

## 2. Stack congelada

| Camada | Escolha | Regra |
|---|---|---|
| Programa on-chain | Rust + Anchor **0.32.1** | Fixar `anchor-lang`, `anchor-spl` e CLI/AVM na mesma versão. Usar interface oficial do Transfer Hook; não implementar controle apenas em Node/JS. |
| Toolchain Solana | CLI/Agave **2.3.0**, versão recomendada pelas notas Anchor 0.32.1 | Fixar no setup e CI. Registrar `solana --version`, `anchor --version`, `rustc --version` e commit/lockfile. Verificar compatibilidade no primeiro dia. |
| Token | SPL **Token-2022** (`Token Extensions`) + extensão **Transfer Hook** | Mint apenas de demo; exigir `ExtraAccountMetaList` para contas do hook. Não usar SPL Token clássico como substituto. |
| Provas | **Solana Attestation Service (SAS)**, contas reais de `Credential`, `Schema`, `Attestation` | Cliente de emissão usa SDK oficial compatível com o lockfile; programa valida contas SAS on-chain. **Não** aceitar JSON, mock, assinatura local ou resposta RPC como substituto de prova no teste de aceite. |
| Cliente/testes | Node.js **22 LTS**, TypeScript, SDK Solana/Anchor compatíveis com 0.32.1, gerenciador `npm` com `package-lock.json` | Node só para app, scripts de criação das contas e testes de integração; autorização é sempre on-chain. Fixar versões resolvidas no lockfile e no README, sem `latest`. |
| UI | React + TypeScript em `app/`, se sobrar tempo | 2 telas simples; o script de transferência independente é mais importante que a UI. |

**Gate técnico até 01/10:** confirmar em fontes oficiais o endereço/program ID SAS na devnet, versão do SDK e formato real das contas e da revogação. Provar, no validator local ou devnet, que o hook consegue receber, derivar e decodificar a conta SAS necessária via `ExtraAccountMetaList`, dentro de limite de compute. O `nonce`/PDA da atestação, `tokenAccount`, sujeito da prova e dono da conta de destino precisam estar vinculados **ao mesmo destinatário**; o hook não pode aceitar uma conta SAS arbitrária fornecida pelo pagador. Não inventar endereço de programa, offset binário ou layout: piná-los após checagem no código e testes. Se esse gate falhar, reportar e reduzir o pitch; não substituir SAS por mock silenciosamente.

## 3. Contrato de interface, versão `aveo-v1`

Este bloco é o acordo entre os módulos. Congelar em `docs/interface-v1.md` antes de codar. Uma alteração exige PR revisado por ambos.

**Entradas e contas do `Execute` hook:** transferência Token-2022 com `source_token`, `mint`, `destination_token`, `authority` e `amount`; `ExtraAccountMetaList` no PDA oficial `['extra-account-metas', mint]`; `IssuerPolicy` PDA do programa Aveo vinculado ao **mint**; contas SAS de `Credential`, `Schema`, `Attestation` para o destinatário e, se a validação exigir, conta/estado SAS adicional. O cliente resolve e anexa as extras on-chain antes de enviar. O hook lê o **owner da conta token de destino**, não confunde `authority` da transferência (pode ser delegate) com destinatário. Nunca confia em endereço SAS digitado na UI sem comparar PDA, owner, schema, credential, signer e sujeito.

**`IssuerPolicy` v1 (persistida on-chain):** `mint`, `issuer_authority`, `sas_program_id`, `schema`, conjunto pequeno de **2 credential IDs/autoridades independentes permitidos**, `active`, `policy_version`. Inicialização e alterações exigem assinatura de `issuer_authority`; não há admin global que aceite todo verificador. Política inicial contém dois autorizados, terceiro proibido. Para alterar/revogar autorização de um verificador, transação assinada pelo emissor; teste confirma efeito. Se o SAS distinguir autoridade da credencial e signer emissor, validar ambos de acordo com seu modelo real. Não usar um único `Credential` com dois signers para simular duas instituições se a tese é independência de verificadores.

**`Attestation` v1 (SAS real):** esquema sem PII: `subject_wallet` (ou vínculo equivalente verificável), `eligible: bool`, `policy_scope` ou identificador do mint, `valid_until`/`expiry`, `nonce`; conta SAS fornece `credential`, `schema`, `signer`, `expiry` e possível `tokenAccount`. Os campos exatos e encoding são os do schema SAS criado no bootstrap e ficam documentados em `docs/interface-v1.md`. Checar `eligible=true`, escopo do mint, expiração pelo `Clock` on-chain, signer autorizado da credencial e credencial permitida pela política. `nonce`/derivação e sujeito devem ligar a prova ao destino. Se o SAS não suportar diretamente algum campo, codificá-lo no **data** do schema com decodificação on-chain testada; jamais presumir que `nonce` por si prova identidade ou titularidade. Atestação fechada/ausente **nega**; política desativada **nega**. Para revogação no MVP, fechar a atestação pelo signer autorizado SAS e provar que a próxima transferência falha; uma lista local de revogação só se for explícita, on-chain e testada.

**Falhas estáveis para testes/UI:** `PolicyMissingOrInactive`, `MintMismatch`, `CredentialNotAllowed`, `SchemaMismatch`, `AttestationMissingOrClosed`, `SubjectMismatch`, `NotEligible`, `AttestationExpired`, `InvalidSasOwnerOrData`, `MissingExtraAccounts`. Nunca usar fallback `allow` diante de conta ausente, layout inesperado ou falha de RPC. Os nomes podem mudar no código, mas o mapeamento documentado e os resultados não.

**Semântica de transferência:** no MVP, a **elegibilidade do destinatário** é obrigatória; o remetente não é atestado, a menos que uma política explícita posterior o exija. Mint/burn podem não passar pelo mesmo hook: não reivindicar cobertura universal de todas as movimentações. `ExtraAccountMetaList` e app precisam resolver a conta de prova correta do destinatário. Um teste com transferência construída fora de `app/` prova que enforcement está no programa.

## 4. Módulos e donos

- **Bruno + Codex:** `programs/aveo-hook/`, `tests/onchain/` e `scripts/bootstrap-mint/`. Implementa política, instruções de init/update, Execute/fallback Anchor, `ExtraAccountMetaList`, validação SAS, testes de transferência e scripts de deploy devnet. Cuidado com upgrades/mint authority; documentar poderes remanescentes em vez de chamar o token imutável.
- **Caio + Cursor:** `app/`, `clients/sas/`, `tests/client/`, UI e roteiro de demo. Cria credential/schema e atestações SAS de teste via SDK oficial; resolve extras, monta transferências, exibe resultado e links das transações; prepara README de usuário e grava demo. Não implementa aprovação off-chain que mascare falha do hook.
- **Juntos em 29-30/09:** `docs/interface-v1.md`, `docs/threat-model.md` e issues de critérios de aceite. Só uma pessoa faz merge do contrato após revisão da outra. Branch/PR separados, sem editar o diretório alheio; contrato alterado apenas em PR comunicado. Não compartilhar a mesma sessão de edição/branch do Codex ou Cursor. Código gerado por IA passa por revisão humana, build, teste e diff.
- **Integração:** Bruno publica IDL, program ID, seeds e contas no contrato; Caio consome sem duplicar literais. Caio entrega fixtures SAS reais; Bruno valida on-chain. Um PR de integração atravessa módulos somente após os dois aprovarem.

## 5. Marcos e testes obrigatórios

| Data-mira | Entrega demonstrável |
|---|---|
| 30/09 | Contrato v1, modelo de ameaça e issues pequenas aceitos pelos dois. Repositório do Caio identificado; ambiente instalado e versões gravadas. |
| 01/10 | Gate SAS/Hook: conta de atestação real lida e validada em um teste mínimo; limitações de compute/contas registradas. |
| 03/10 | Mint de teste + hook rejeita uma transferência não elegível; SAS emite prova de teste por verificador A e B. |
| 05/10 | Primeira transferência válida e uma inválida fora da UI, com logs e assinatura. Se ainda não houver bloqueio on-chain real, cortar polimento de UI e concentrar nos testes. |
| 07/10 | Devnet end-to-end, todos os cenários abaixo verdes; scripts reproduzíveis e erros claros. |
| 09/10 | Congelar features; README, instruções de build e links de prova. Pitch em inglês distingue Civic e o que não foi validado institucionalmente. |
| 10-11/10 | Demo filmada, teste a partir de clone limpo, revisão de segurança/privacidade e formulário de submissão preparado sem enviar. |
| 12/10 | Buffer; Bruno decide separadamente inscrição e submissão. Não deixar para o limite do Pacífico. |

**Matriz de aceite (automatizar em validator local e repetir os principais em devnet):**

1. Mint Token-2022 e hook/`ExtraAccountMetaList` ativos; transferência a destino com `eligible=true`, não expirado, esquema/escopo corretos e prova emitida por **A** liquida. Repetir com **B** sob a mesma política sem reescrever o hook.
2. Destino sem prova, `eligible=false` ou prova de **C não autorizado**: transação Token-2022 falha e saldos não mudam.
3. Prova de A vinculada à carteira X passada numa transferência para Y: falha (`SubjectMismatch`). Prova de outro mint ou schema: falha.
4. Fechar/revogar prova SAS de X e repetir a **mesma transferência**: falha; expiração pelo relógio on-chain: falha. Remover A da política assinada pelo emissor: provas de A deixam de passar, B continua válido.
5. Tentar uma transferência via script independente, sem `app/`, com extras corretas: mesmas aprovações/recusas. Sem contas extras, transação deve falhar, não contornar o hook.
6. Política inativa, conta forjada com owner diferente de SAS, dados malformados e emissor sem assinatura tentando alterar política: falham. Testes não mostram nem registram PII.

**Pronto para o pitch:** repo privado ou público conforme decisão de Bruno e regras, lockfiles/commit, comandos de instalação/build/test/deploy, tabela de testes com links devnet de operações bem-sucedidas e evidência reproduzível de rejeições (simulação/logs: transações falhas podem não ter assinatura confirmada), vídeo curto de transferência permitida/negada/revogação, diagrama público/privado, comparação honesta com Civic. Não alegar auditoria, adesão de emissor real, interoperabilidade geral, conformidade LGPD ou privacidade garantida.

## 6. Referências técnicas e regras

- Transfer Hook, interface `Execute`, fallback Anchor e PDA `ExtraAccountMetaList`: https://solana.com/docs/tokens/extensions/transfer-hook
- Integração de cliente e resolução das contas extras: https://solana.com/docs/tokens/extensions/transfer-hook-integration
- SAS: estrutura de `Attestation`, `Schema`, `Credential`, PDA/nonce e fechamento: https://attest.solana.com/docs/attestations ; https://attest.solana.com/docs/schemas ; https://attest.solana.com/docs/credentials ; https://attest.solana.com/docs/helpers ; https://attest.solana.com/docs/instructions/close-attestation
- Exemplo Rust oficial de fluxo SAS: https://attest.solana.com/docs/guides/rust/tokenized-attestations (exemplo tokenizado não obriga tokenizar a credencial Aveo).
- Anchor 0.32.1, recomenda Solana 2.3.0: https://www.anchor-lang.com/docs/updates/release-notes/0-32-1
- Precedente Civic: https://github.com/civicteam/token-extensions-transfer-hook
- Regras e prazo: https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf
