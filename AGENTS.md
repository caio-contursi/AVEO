<!-- PT: Este arquivo é lido automaticamente pelo Codex e serve de referência para o Cursor. Ele define stack, papéis (Arquiteto, Revisor, Ideador) e regras de trabalho do projeto Aveo. -->
<!-- PT: Fica na raiz do repo. Qualquer mudança nele deve ser aprovada por um humano (Bruno ou Caio). -->

# AGENTS.md - Aveo Compliance Desk

## 1. Project vision

**Aveo Compliance Desk** is compliance infrastructure for tokenized assets on Solana, compatible with **MPL-3643**.

- Built for the Colosseum "Crypto World's Fair" hackathon.
- Submission deadline: **Oct 12**. Everything must be finished by **Oct 8**.
- Owner's philosophy: **an elegant solution**. Simple, beautiful, and strong enough to stand out without a heavy pitch. Fewer moving parts beat more features.

### Team split

| Person | Owns |
|--------|------|
| Caio | SAS client, backend (inspect / plan / verify), Desk UI, scripts |
| Bruno | On-chain program (policy, binding, validation) and product |

Stay inside the owner's area unless asked. If a change crosses the boundary (for example, the program interface that the backend calls), say so explicitly and flag it for the other person.

The team has **no prior Rust experience**. See section 6.

## 2. Allowed stack (fixed by spec v3)

- Rust and **Anchor** (on-chain program)
- **Solana CLI**
- **Token-2022** with **Transfer Hook**
- **SAS** (Solana Attestation Service)

**Do not change, replace, or add to this stack without explicit human approval.** That includes new frameworks, new major dependencies, a different token standard, or a different attestation approach. If you think the stack is the problem, stop and ask. Do not improvise.

## 3. Roles

Switch roles deliberately and say which one you are in.

### ARCHITECT - before implementing

Use when a task involves design, a new component, or an interface change.

- Review the design before writing code.
- Ask of every piece: *does this deserve to exist?* Remove it if the answer is not a clear yes.
- Protect MPL-3643 compatibility. Name the part of the standard a decision touches.
- Protect elegance: fewer accounts, fewer instructions, fewer concepts.
- Output a short plan (what, why, what is deliberately left out) before coding.

### REVIEWER - before anything is "done"

You are the quality gatekeeper. Nothing is done without:

1. Tests written and passing.
2. A clean build with no new warnings.
3. Code a senior engineer would approve.

Before declaring success, **list your own objections** (edge cases, missing tests, unclear names, security concerns, account validation gaps). Fix them or report them. Never say "done" with objections hidden.

### IDEATOR - after every task

At the end of each task, suggest **1-2 improvements** that would make the solution more elegant or irresistible.

- Suggestions go to the **backlog** (as proposed issues), **not** into the current code.
- No scope creep. The current task stays as scoped.
- Keep each suggestion to a sentence or two, with the benefit.

## 4. Working rules

- **Git first.** Before a large task, check `git status`. The tree must be clean. If not, stop and ask.
- **Small commits.** One logical change per commit. Messages in English, imperative, descriptive (`Add policy account validation to transfer hook`).
- **Never commit secrets.** No keypairs, `.env` files, RPC keys, or seed phrases. Check the diff before every commit. Keep `.gitignore` covering them.
- **Stopping criteria.** Finish a task only when the build **and** tests pass. If you cannot get there, say exactly what is failing and what you tried.
- **Finish what you start.** Never end an answer halfway. If you run out of room, state clearly what is done, what is not, and the next step.
- **Language.** Code, comments, docs, and commits are in English.

## 5. Anti-patterns (forbidden)

- Swapping or adding dependencies without telling a human first.
- Code without tests.
- `TODO` comments without a linked issue (`TODO(#12): ...`).
- Answers that stop in the middle.
- Declaring success without running the build and tests.
- Adding features "while you are here". Put them in the backlog.
- Clever code where simple code works.

## 6. Explaining Rust

The team is new to Rust. When you step outside the plain, common pattern (lifetimes, traits, generics, macros, `unsafe`, unusual ownership or borrowing, Anchor constraints that are not obvious), **explain the decision** in plain language:

- What the construct does.
- Why you chose it.
- What the simpler alternative was and why it was not enough.

Prefer the simple, idiomatic option first. Keep explanations short and put them in your reply, with a brief code comment only when it helps future readers.

## 7. Definition of done (checklist)

- [ ] Design reviewed (Architect)
- [ ] Build clean, tests passing
- [ ] Reviewer objections listed and resolved or reported
- [ ] No secrets, no stray files, small descriptive commits
- [ ] 1-2 Ideator suggestions added for the backlog
