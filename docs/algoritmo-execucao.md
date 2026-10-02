# Aveo — O plano como um algoritmo

Versão simplificada do `plano-execucao.md` para quem não conhece blockchain, Solana ou Rust.
Leia de cima para baixo, como uma receita. Cada passo diz **quem faz**, **o que faz** e **como saber que terminou**.

---

## Parte 1 — Entendendo o projeto em 1 minuto

Imagine um **clube com porteiro**.

- O **token** (Alfa ou Beta) é o clube. Só entra ou sai quem tem autorização.
- A **atestação** é uma **carteirinha** emitida por uma empresa verificadora (A ou B), dizendo "esta pessoa passou no cadastro". Ela tem data de validade.
- O **hook** é o **porteiro**. Ele fica dentro da blockchain e confere a carteirinha **toda vez** que alguém tenta mover o token. Não dá para passar por outra porta.
- A **policy** é a **regra de cada clube**. O clube Alfa aceita carteirinha de A ou B. O clube Beta só aceita de A e exige também "investidor qualificado".
- O **Desk** é o **painel do gerente**. Ele mostra quem pode entrar, quem perdeu a carteirinha, quais clubes foram afetados e ajuda a resolver.

**A grande ideia:** uma única carteirinha serve para vários clubes, e cada clube mantém sua própria regra. Quando a carteirinha vence, o gerente vê o problema em todos os clubes de uma vez e acompanha a solução.

Tudo é **fictício** (dados sintéticos) e roda na **devnet**, uma blockchain de testes em que o dinheiro não é real.

---

## Parte 2 — Glossário mínimo

| Termo | Em palavras simples |
|---|---|
| Blockchain | Um livro-caixa público que ninguém consegue apagar |
| Solana | A blockchain que vamos usar |
| Devnet | A versão de testes da Solana, com dinheiro de brincadeira |
| Carteira (wallet) | A "conta" de uma pessoa na blockchain, identificada por um endereço |
| Token | Um ativo digital; aqui são Alfa e Beta |
| Token-2022 | O modelo de token da Solana que permite colocar um porteiro |
| Transfer Hook | O porteiro: código que roda em toda transferência |
| Programa | Código que roda dentro da blockchain (escrito em Rust) |
| Rust / Anchor | A linguagem e o kit usados para escrever o programa |
| SAS | O serviço oficial da Solana que emite as carteirinhas (atestações) |
| Atestação | A carteirinha: "a verificadora X afirma que a carteira Y passou no cadastro" |
| Policy | A regra de cada token |
| Binding | O vínculo: "no clube Alfa, eu apresento a carteirinha nº tal" |
| Incidente | Um problema detectado, por exemplo uma carteirinha vencida |
| Readback | Ler de novo a blockchain para confirmar que algo aconteceu de verdade |
| Mock | Um dado falso para testar. **Não vale como prova de que funciona** |

---

## Parte 3 — As 4 equipes (frentes)

| Frente | Apelido | O que faz | Precisa saber |
|---|---|---|---|
| F1 | **O Porteiro** | Escreve o programa que confere a carteirinha | Rust (com ajuda de IA) |
| F2 | **O Cartório** | Emite as carteirinhas, cria os tokens e as carteiras de teste, roda os testes | TypeScript |
| F3 | **O Cérebro do Painel** | Lê a blockchain, detecta problemas e prepara as ações | TypeScript |
| F4 | **A Vitrine** | Faz as telas, a documentação, o vídeo e a inscrição | React / escrita |

**Líder do projeto:** acompanha as 4 frentes, aprova as mudanças e decide nos pontos de decisão.

---

## Parte 4 — O algoritmo

```
INÍCIO (30/09)

PASSO 0 — Preparar todo mundo                      [todos, até 01/10]
    Cada pessoa:
        instalar as ferramentas da sua frente
        estudar a Parte 1 e a Parte 2 deste documento
        fazer o "primeiro contato":
            criar uma carteira na devnet
            pedir moedas de teste (airdrop)
            enviar uma transferência de teste
    Todos juntos:
        escrever o "contrato entre as equipes" (docs/interface-v2.md):
            nomes das contas, formato da carteirinha, lista de erros
    PRONTO QUANDO: todos fizeram uma transferência de teste
                   E o contrato entre equipes foi aprovado pelo líder

PASSO 1 — Provar que o porteiro consegue ler a carteirinha   [F1 + F2, até 02/10]
    F2: emitir UMA carteirinha real (atestação SAS) na devnet
    F1: fazer o porteiro (hook) ler essa carteirinha durante uma transferência
    F1: medir se cabe no limite de processamento da Solana
    F3 e F4 (em paralelo): montar o esqueleto do painel e das telas

    DECISÃO 1 (02/10):
        SE o porteiro leu a carteirinha real
            ENTÃO seguir para o PASSO 2
        SENÃO
            usar o plano B: localizar a carteirinha por um endereço calculado
            repetir o PASSO 1 (máximo 1 dia a mais)
            SE ainda falhar → avisar o líder e reduzir o projeto

PASSO 2 — Dois clubes, uma carteirinha                [F1 + F2 + F3, até 04/10]
    criar os tokens Alfa e Beta, cada um com sua regra
    carteira X: uma carteirinha de A → deve passar nos dois clubes
    carteira Y: carteirinha de B    → passa em Alfa, é barrada em Beta
    rodar uma transferência por um script, SEM usar o nosso painel
    F3: o painel já consegue dizer "pode" / "não pode" e por quê

    DECISÃO 2 — continuar ou reduzir (04/10):
        SE tudo acima funciona na blockchain de verdade
            ENTÃO seguir para o PASSO 3
        SENÃO
            cortar partes opcionais e focar só no que falta
            SE mesmo assim não há como funcionar → líder decide se ainda vale enviar

PASSO 3 — O ciclo do problema                         [todos, até 06/10]
    fazer a carteirinha de X vencer (ou ser cancelada)
    confirmar: X não consegue mais mover Alfa nem Beta,
               MESMO com o painel desligado
    o painel detecta e mostra UM incidente afetando os dois clubes
    emitir uma carteirinha nova
    X assina o novo vínculo
    o painel confirma na blockchain que voltou a funcionar → incidente resolvido
    F4: as 3 telas ligadas aos dados reais

PASSO 4 — Testar de verdade                           [F2 + F1, até 07/10]
    rodar tudo na devnet, do começo ao fim
    rodar os 17 testes da lista (T01 a T17 no plano completo)
    PARA CADA teste:
        SE passou → marcar PASS
        SE falhou → marcar FAIL e registrar o motivo (nunca esconder com mock)

PASSO 5 — Congelar                                    [líder, 08/10]
    a partir de agora: NADA de funcionalidade nova, só correção de erro
    F4: README, documentação e lista de limitações prontos

PASSO 6 — Revisar                                     [todos, 09/10]
    uma pessoa baixa o projeto do zero em outro computador e segue o README
    SE funcionou → ok
    SENÃO → corrigir o README ou o erro e repetir
    revisar: nenhum dado real, nenhuma senha ou chave no código

    OPCIONAL: SE tudo está verde E sobrou tempo
        ENTÃO tentar o "copilot" (assistente de IA só de leitura), no máximo meio dia
        SENÃO pular

PASSO 7 — Gravar                                      [F4 + líder, 10/10]
    gravar o vídeo de ~3 minutos seguindo o roteiro
    líder assiste e aprova

PASSO 8 — Enviar                                      [líder, 11/10]
    preencher o formulário do Colosseum
    anexar vídeo, repositório e pitch
    ENVIAR

PASSO 9 — Reserva                                     [12/10]
    só para emergência

FIM
```

---

## Parte 5 — Fluxograma resumido

```
 [Preparar] → [Porteiro lê carteirinha?] ──não──> [Plano B] ──falhou──> [Reduzir projeto]
                        │ sim                          │ ok
                        ▼                              ▼
             [Dois clubes, uma carteirinha] ←──────────┘
                        │
               [Funciona na blockchain?] ──não──> [Cortar opcionais]
                        │ sim
                        ▼
             [Ciclo: vence → detecta → renova → resolve]
                        ▼
                   [Testar tudo]
                        ▼
                    [Congelar]
                        ▼
                    [Revisar]
                        ▼
                     [Gravar]
                        ▼
                     [ENVIAR]
```

---

## Parte 6 — Regras de ouro (para todos)

1. **Se não rodou na blockchain, não está pronto.** Tela bonita não é prova.
2. **Nunca invente** um endereço, número ou versão. Se não sabe, pergunte ou pesquise na documentação oficial.
3. **Nada real:** nada de CPF, carteira pessoal ou dinheiro de verdade.
4. **Nenhuma senha ou chave** vai para o repositório.
5. **Travou por mais de 2 horas?** Avise o líder na hora. Bloqueio escondido atrasa todo mundo.
6. **IA ajuda, mas não decide:** todo código gerado por IA precisa compilar e passar no teste.
7. **Mudou o contrato entre equipes?** Só com aprovação do líder.

---

## Parte 7 — Rotina diária (15 minutos)

```
PARA CADA pessoa:
    dizer o que terminou ontem
    dizer o que vai fazer hoje
    dizer se está travada em algo
Líder:
    conferir se o passo do dia está no prazo
    SE hoje é dia de decisão → decidir e anotar
```
