# Aveo demo recording — a decision, not a feature tour

This is a recording plan, not evidence that the pending six-scene acceptance has
passed. No new transactions or wallet tests were performed to write it. Use
[current status](../current-status.md) and record only outcomes actually observed.

## The narrative

Opening: **“A transfer is blocked. Let's find out why — and follow the evidence.”**
Explain one operator task. Avoid scrolling through every menu or listing test counts.
The core chain is cause → affected assets → correction → confirmed fresh state.
Choose live subjects after checking the current deployment: existing proofs can
expire, so yesterday's green screenshot is not today's state.

## Preparation and recording safety

1. Use the public Desk in English, with devnet visible. Capture the app window,
   not corporate documents, notifications, credentials or seed phrases.
2. Select the demonstration subjects and record starting balances/proof references.
   Use a separate provisioned test wallet for signed actions. A visitor's wallet
   cannot sign as Wallet X. Do not import server fixture keys.
3. Keep Explorer open for the actual signatures. Build a dedicated short-lived
   proof scenario before attempting the expiration/renewal story; do not destroy
   the public observation scenario just to manufacture a dramatic failure.
4. Rehearse and validate before filming. If a scene fails, retain its failed evidence,
   fix the issue and record again. Never replace ledger execution with mock results.
5. Record segments, then cut waits transparently. Keep the final video under three
   minutes. Recording cuts are allowed editorially; they must not imply atomicity,
   uninterrupted execution or completion of an unexecuted scene.

## Full target walkthrough — only after prerequisites pass

| Time | Screen/action | Short narration | Required proof |
| --- | --- | --- | --- |
| 0:00–0:15 | Current matrix and devnet context | “The same wallet can face different rules for different assets.” | Fresh reads, no stale screenshot |
| 0:15–0:35 | Compare the shared proof reference on Alfa/Beta | “One proof, two assets. Each asset still owns its policy.” | Both bindings reference the same actual attestation |
| 0:35–0:55 | Show an accepted/rejected policy-specific subject | “The interesting part is not the color. It's the reason.” | Correct eligibility reasons; this alone is not a rejected transfer |
| 0:55–1:20 | Independent Token-2022 client and Explorer | “Changing the interface doesn't remove the on-chain rule.” | Actual hook invocation; allowed/rejected outcomes and preserved balances |
| 1:20–1:40 | Dedicated proof expiry; rejected attempt | “Time changed the eligibility. The blockchain blocked the transfer.” | Validator-clock expiry, rejection attribution, unchanged balances |
| 1:40–2:00 | Incident scan and proof-based grouping | “Two affected assets. One cause to investigate.” | Actual common proof and live incident observations |
| 2:00–2:40 | Prepare/simulate, test-wallet signature, receipt, fresh read | “We don't call it fixed when the user clicks. We verify the new state.” | Original signature, confirmed bindings/eligibility and expected balances |
| 2:40–2:55 | Live URL and final verified state | “Open Aveo, inspect a wallet–asset result, and ask why.” | Clearly disclose synthetic devnet data and any remaining acceptance |

Show reload recovery as a short additional evidence clip if it is genuinely
validated and time permits; otherwise link a separate technical recording. Do
not crowd the main demo or claim a reconnect test when confirmation was already
complete. Recovery uses the original browser origin/storage and signature, never
a second transaction. Smartphone signing can be shown in a clearly identified clip;
it is not a desktop-extension test or cross-device storage recovery.

## What can be recorded before wallet acceptance

Read-only public matrix, diagnosis, proof/policy comparison and network context can
be filmed now after checking actual state. Transaction preparation/simulation can
be shown only when it succeeds with the actual selected accounts. The outside-Desk,
expiry enforcement and signed-renewal scenes require their own real execution
evidence: do not imply that opening those screens completes them. Historical localnet
clips must say **localnet** and show their date/context, not appear as public devnet.

If these gates remain open, submit an honestly scoped technical walkthrough rather
than staging a completed flow. Use “implemented; real-wallet acceptance pending”
for unvalidated wallet code. An empty incident page is not evidence of grouping.

## Delivery tips for the pitch

The v0.3 pitch script is written for Bruno. Say the first two sentences to the
camera before advancing slides. Pause after “a compliance dad joined a blockchain
team”; do not force a joke. Stress “one shared cause”, “the chain enforces”, and
“follow the evidence”. Present the ten-asset example as hypothetical; the working
demo has two assets. The 2024 McKinsey projection excludes crypto/stablecoins and
is industry context, not software TAM, revenue or proven demand for Aveo.

Use your own voice and natural pauses. Reading mode advances manually; there is
no promise of a particular recording duration. Rehearse against a timer, aiming
below 2:50 with a margin, and shorten rather than speed up if it exceeds three minutes.
No grant, prize, audit or customer outcome is guaranteed by this narrative.
