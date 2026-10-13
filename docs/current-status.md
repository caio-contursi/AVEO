# Current release status

Snapshot: 2026-10-12. This is the current reader-facing checklist, not an audit.
Historical append-only reports retain their original observations and failures;
their older prerequisite statements are not the present deployment status.

## Delivered and observed

- Public site: https://aveoprotocol.io, connected to genuine Solana devnet accounts.
- Dedicated program: `28DDiRDHkqaYYYaZvoFDDpwxUfuZcaehjJpiZfKwzuKS`; deployed
  binary was compared with the approved build. See [deployment record](public-demo-release.md).
- Public [manifest](../config/deployment.devnet.json): Alfa/Beta, synthetic subjects,
  independent policies and SAS proofs. The successful fixture run confirmed 33 operations.
- HTTP/WebSocket access through the bounded Helius intermediary; no credential
  in the served browser assets or public manifest. [Release evidence](helius-rpc.md).
- Last recorded regression: 2664 app/script tests, 41 backend tests, 26 intermediary
  tests, typechecks, lint and build. This historical count is not an immutable target;
  rerun verification for the final submitted commit.
- Last public read-only Chromium run: eight desktop/mobile route observations,
  55 protected RPC requests, zero RPC/JavaScript errors and zero transaction sends.
  Headless mobile viewport tests are not physical-device or wallet-extension tests.

## Acceptance still open

| Gate | Remaining evidence | Owner |
| --- | --- | --- |
| External test wallet | Register/provision an approved test wallet and execute the checklist below | Operator + integration/QA |
| Mandatory security | Aggregate T04; explicit wrong mint/domain T05; account-owner/substitution/schema T10; accurate live/unit expiry boundary T17 distinction | On-chain/SAS reviewer |
| Interruption | Real-wallet reload recovery using the original operation; controlled faults alone do not close extension acceptance | Operator + QA |
| Public six scenes | Proof reuse, independent policies, external transfer, real expiry rejection, grouped impact, signed renewal with fresh readback | Release/QA + operator |
| Reproducibility | Install, verify and execute the declared workflow from a clean clone of the delivered revision | Release reviewer |
| First use | Consenting newcomer understands and completes the supported path without coaching; physical-device checks | Product/QA |
| Delivery packet | Owner-approved license, presentation/video, final English submission links and coherent evidence | Project owners |

There is no hosted CI workflow or versioned license at this snapshot. Real KYC,
mainnet, independent professional audit, MPL-3643 integration and commercial/pilot
validation are not completed and must not be claimed. [Security subcase details](security-matrix-progress.md).

## Wallet acceptance

1. Create a separate test wallet, select Solana Devnet and open the public site.
2. Reject connection, then approve connection; confirm the correct public address.
3. Stop until the team registers/provisions that address with test SOL, tokens,
   a synthetic proof and the required bindings. Never import server fixture keys.
4. Prepare the agreed permitted transfer, inspect simulation and reject signing.
   Record that no submission occurred and balances are unchanged.
5. Prepare again, approve signing, retain the public signature, confirm the original
   transaction and verify exact fresh balance changes.
6. On a separate agreed transfer, interrupt reads after the original signature has
   been recorded, reload and recover that same operation in Receipts. Do not submit
   another transaction. If it settles before interruption, the fault test is not run.
7. Exercise the designated ineligible-destination scenario. Record correct rejection
   attribution and unchanged balances; a disabled UI button alone is not on-chain evidence.

Record device, browser/wallet version, source/runtime identity, network, public
addresses, transaction signature/slot, expected versus observed results and screenshots.
Never record seed phrases, private keys or API credentials. Unknown stays unknown
until reconciled. Do not clear storage or switch origins to bypass a pending guard.

## Public six-scene signoff

Use [public-demo-release.md](public-demo-release.md) for the scene requirements.
The existing [judge walkthrough](judge-walkthrough.md) documents historical local
ledger evidence, not completed public signoff. Proof closure and proof expiry are
different scenarios; do not narrate closure as expiration. Use dedicated synthetic
subjects and short-lived proofs, preserving the public observation scenario.

## Before final submission

Rerun verification, identify the delivered source and image versions, verify manifest
and live deployment, consolidate case evidence with PASS/FAIL/NOT_RUN, reproduce a
clean-clone install and rehearse the wallet/public flow. Then update this snapshot
only for gates backed by retained evidence. Merge approval is not test acceptance.
