# Aveo Compliance Desk (front-end)

Interface do Desk (F4) para a rota B da spec v3: o programa `aveo-hook` (Transfer Hook do Token-2022) decide cada transferência a partir de uma prova SAS. O Desk responde três perguntas:

- esta carteira pode mover este ativo agora?
- qual prova sustenta essa resposta?
- se a prova deixou de valer, quais ativos foram afetados, e como fechar o incidente com evidência?

> Provas sintéticas; demo devnet; sem KYC real.

O "backend" aqui é on-chain: `aveo-hook`, SAS e Token-2022. Não existe API HTTP. O front lê as contas pelo RPC, simula as transações e pede a assinatura à carteira. A decisão continua sendo do hook: o Desk explica e prepara, nunca aprova.

## Stack

Vite 7 + React 19 + TypeScript, `@solana/kit` 8, `@solana-program/token-2022`, Wallet Standard (`@solana/react`), TanStack Query, react-router, zod, Vitest e ESLint.

A escolha segue o que o backend já usa: `@solana/kit` e o cliente oficial do Token-2022 resolvem as contas extras do hook do mesmo jeito que qualquer carteira. Wallet Standard evita prender o Desk a uma carteira específica. Vite + React é a base mais curta para uma SPA estática, sem servidor próprio.

## Telas

| Tela | O que faz |
|---|---|
| **Carteiras e ativos** | Políticas de Alfa e Beta, provas SAS (com a prova compartilhada entre ativos), matriz carteira × ativo com o diagnóstico na ordem do hook, vínculo de prova (`set_binding`) e edição de política pelo emissor (`update_policy`) |
| **Transferência** | Formulário validado, diagnóstico de origem e destino, simulação com unidades de computação e logs, assinatura só pela carteira de origem, evidência com saldos antes e depois e readback |
| **Incidentes** | `scan:once` por botão, incidentes agrupados por prova e sem duplicar, ciclo aberto → ação preparada → aguardando confirmação → resolvido, novo vínculo assinado pelo titular, resolução só com leitura nova |
| **Rede** | Versão do nó, programas implantados, slot, configuração e manifest em uso |

Interface em português e inglês (seletor no topo). Todas as telas têm estados de carregamento, erro e vazio, e funcionam no celular.

## Pré-requisitos

| Ferramenta | Versão | Para quê |
|---|---|---|
| Node | 22 ou superior | front e scripts |
| pnpm | 10.x | workspace (`corepack enable` ou `npx pnpm@10.33.3`) |
| Docker | Desktop ou Engine | validador local com o `aveo-hook` (não precisa de Rust nem Solana no host) |

O ambiente Docker baixa e guarda cerca de 4 GB (Agave 2.3.0, platform-tools v1.53, build do programa) na pasta `AVEO_DEV_HOME`. O padrão é `~/.aveo-dev`. No Windows, aponte para um disco com espaço, por exemplo `E:\aveo-dev`.

## Instalação

Na raiz do repositório (o `app/` é membro do workspace pnpm):

```bash
pnpm install
```

## Configuração

Copie o exemplo e ajuste:

```bash
cp app/.env.example app/.env.local
```

| Variável | Padrão | Uso |
|---|---|---|
| `VITE_CLUSTER` | `localnet` | `localnet` ou `devnet` |
| `VITE_RPC_URL` | `http://127.0.0.1:8899` | RPC HTTP |
| `VITE_COMMITMENT` | `confirmed` | `processed`, `confirmed` ou `finalized` |
| `VITE_AVEO_PROGRAM_ID` | vazio | troca o program ID; vazio = `declare_id!` (`ExAoxPmugpGbYTVB31oDTqkkG12PM6neFq4vhM6LJd33`) |
| `VITE_DEPLOYMENT_URL` | `/dev/deployment.json` | manifest com mints, verificadores e carteiras da demo |
| `VITE_BACKEND` | `aveo-sas-hook` | `aveo-sas-hook` (rota B) ou `mpl3643` (rota A: só mostra "não integrado" até o gate A) |
| `VITE_ENABLE_DEV_WALLETS` | `false` | libera as carteiras sintéticas dos fixtures; só funciona no servidor de desenvolvimento e fora da devnet |

As variáveis são validadas na inicialização. Se alguma estiver errada, o Desk mostra a lista em vez de abrir.

Para usar o validador local com as carteiras de teste, o `app/.env.local` fica assim:

```bash
VITE_CLUSTER=localnet
VITE_RPC_URL=http://127.0.0.1:8899
VITE_ENABLE_DEV_WALLETS=true
```

## Execução contra o validador local

Todos os comandos rodam a partir de `app/` (ou com `pnpm --filter @aveo/app <script>` na raiz).

1. Compile o `aveo-hook`. A primeira vez demora, porque baixa o Agave e as platform-tools:

   ```bash
   pnpm solana:build
   ```

   O repositório é montado **somente para leitura** no container. Nada do backend é alterado, e o build sai em `AVEO_DEV_HOME`.

2. Suba o validador. Ele carrega o `aveo-hook` compilado e cópias do SAS e do Token-2022 da devnet:

   ```bash
   pnpm solana:validator
   ```

   `pnpm solana:logs` acompanha os logs e `pnpm solana:stop` derruba o validador. Cada `solana:validator` começa de um ledger limpo, gravado em `AVEO_DEV_HOME/ledger`. O RocksDB do validador cresce rápido (cerca de 2 GB em 40 minutos), então pare o validador quando não estiver usando.

3. Crie o cenário da spec: verificadores A e B, provas de tesouraria, X, Y e Z, mints Alfa e Beta com políticas e bindings, e as transferências iniciais.

   ```bash
   pnpm fixtures
   ```

   Gera `app/.dev/deployment.json` (endereços) e `app/.dev/wallets.json` (chaves das carteiras sintéticas). Os dois ficam fora do git. Por padrão, a prova de X vale 20 minutos; mude com `pnpm fixtures --x-ttl 600` (segundos).

   Se o Desk já estiver aberto, recarregue a página depois dos fixtures. O histórico de incidentes começa vazio a cada nova geração.

4. Inicie o Desk:

   ```bash
   pnpm dev
   ```

   Abra http://localhost:5173. Para assinar, use "Conectar carteira": aparecem as carteiras Wallet Standard instaladas e, com `VITE_ENABLE_DEV_WALLETS=true`, as carteiras de teste (emissor, verificadores, tesouraria, X, Y e Z).

### Roteiro da demo

`pnpm scenario` faz, fora da UI, o que caberia ao verificador ou a uma carteira qualquer:

```bash
pnpm scenario status                    # elegibilidade e saldos de todas as carteiras
pnpm scenario close X                   # verificador fecha (revoga) as provas de X
pnpm scenario issue X                   # verificador emite uma prova nova para X
pnpm scenario transfer alfa X Y 1       # transferência sem o Desk: só o hook decide
```

Fluxo testado de ponta a ponta:

1. **Carteiras e ativos.** X é elegível em Alfa e Beta com a mesma prova. Y é recusada em Beta, porque Beta não aceita o Verificador B. Z é recusada em Beta por falta de credenciamento.
2. **Transferência** X → Y em Alfa: simulação aprovada, X assina, a evidência mostra os saldos antes e depois.
3. A prova de X vence (ou rode `pnpm scenario close X`). `pnpm scenario transfer alfa X Y 1` é recusada pelo hook com o Desk desligado.
4. **Incidentes → Escanear agora.** Um incidente de X agrupa Alfa e Beta. Escanear de novo ou recarregar não duplica.
5. `pnpm scenario issue X`. Depois, "Preparar novo vínculo", "Assinar como Carteira X" e "Verificar com leitura nova": o incidente fica resolvido, com a evidência dos dois `set_binding`.
6. A transferência fora da UI volta a passar.

## Build, lint e testes

```bash
pnpm build       # tsc -b + vite build → app/dist
pnpm lint
pnpm test        # Vitest: codecs, regras do hook e ciclo de incidentes
pnpm typecheck
pnpm preview     # serve o build
```

O build é estático (SPA com hash router). Em produção, o manifest precisa estar publicado no endereço de `VITE_DEPLOYMENT_URL`, por exemplo em `public/`. As rotas `/dev/*` e as carteiras de teste existem só no servidor de desenvolvimento.

## Estrutura

```
app/
  src/
    api/          camada de acesso à rede: codecs, PDAs, leituras, diagnóstico, planos, envio e verificação
    config/       variáveis de ambiente e manifest de deploy (validados com zod)
    wallet/       Wallet Standard e carteiras de teste
    i18n/         dicionários pt e en
    components/   componentes de interface compartilhados
    features/     telas: assets, transfer, incidents, status, operations (simulação, assinatura e evidência)
    app/          providers, layout e rotas
  scripts/        fixtures e scenario (somente localnet)
  dev/solana/     imagem Docker do validador local
```

A camada `src/api` implementa o contrato `EligibilityBackend` / `RenewBindingCapable` de `@aveo/contracts`, em `AveoSasHookBackend` (`src/api/backend.ts`). Ela não depende de React; o resto do app só a usa por esse contrato.

## Limites e mocks

- **Histórico de incidentes (MOCK).** Fica no `localStorage` deste navegador (`src/features/incidents/store.ts`), no lugar do SQLite do `backend-aveo`, que ainda não existe. A tela mostra o selo "MOCK".
- **inspect/plan/verify rodam no navegador**, sobre a rede real, porque `packages/backend-aveo` está vazio.
- **Fixtures e scenario** são só para localnet, com carteiras sintéticas. As chaves nunca vão para o build.
- Rede local não tem explorador: a evidência mostra a assinatura sem link.

Pendências encontradas no backend (sem correção, por regra): [`docs/backend-pendencias.md`](../docs/backend-pendencias.md).
