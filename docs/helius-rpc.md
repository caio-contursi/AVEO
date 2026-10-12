# Private devnet RPC intermediary

The Desk accesses `https://aveoprotocol.io/rpc`. A separate Node.js service forwards
approved requests to Helius devnet. No API credential is included in the public
manifest, browser bundle, Docker build arguments, source repository or logs.
This transport change does not claim MPL-3643 integration and changes no on-chain
instruction, policy, proof or token. Application/hosting changes require Caio's review.

## Deployment

The host credential is a nonempty API key, not a URL, stored outside the repository
at `/home/bruno/.config/aveo/helius-devnet.key`, owned by UID 1002 with mode 0600.
The intermediary runs as UID 1002 and reads the runtime-mounted secret. Startup
verifies the devnet genesis hash; a failed check prevents readiness.
Both services use host networking because outbound requests through the default
Docker bridge fail in this VPS. Nginx binds only `127.0.0.1:8090`; the intermediary
binds only `127.0.0.1:8787`. This preserves the existing reverse-proxy destination
but removes container network isolation. Never broaden those listeners to `0.0.0.0`.

```bash
pnpm verify
AVEO_PUBLIC_MANIFEST=/home/bruno/projetos/AVEO/config/deployment.devnet.json \
  docker compose -p aveo-bruno -f compose.web.yaml build
AVEO_PUBLIC_MANIFEST=/home/bruno/projetos/AVEO/config/deployment.devnet.json \
  docker compose -p aveo-bruno -f compose.web.yaml up -d --no-build
```

First test the built candidate without replacing the public container. Preserve
the current web image ID under a rollback tag before activation. A web rollback
must use its previous image; it must not redeploy the program or regenerate fixtures.
Never print the secret or paste an upstream URL into screenshots or support messages.

For this release, Docker could no longer tag/commit the running image because its
content digest was unavailable. The exact running public HTML/assets and nginx
configuration were copied into `/tmp/aveo-pre-helius-backup-sP3o7n` and rebuilt as
`aveo-bruno-aveo-web:pre-helius-20261012`; its manifest and HTTP serving were tested
in an offline container. This is a static-serving rollback, not original build provenance.
To restore it after a failed publication, stop only the new `aveo-web` service, then
run the backup image with `127.0.0.1:8090:80`. Do not reuse the new host-network nginx
configuration with this old image: its preserved nginx configuration listens on port 80.

## Deliberate controls and limits

- Fixed Helius devnet upstream; caller-supplied URLs and query strings are rejected.
- HTTP POST JSON only, single JSON-RPC envelopes, an explicit method allowlist and
  filtered SAS discovery. Faucet calls and unrestricted program scans are denied.
- Global admission cap: 240 requests/minute, 32 admitted HTTP operations, at most
  8 retained upstream responses and one upstream request start every 150 ms, a
  128 KiB request cap, an 8 MiB response cap and a 15-second upstream deadline.
- SAS scans start at least 250 ms apart; transaction submissions at least 1.1
  seconds apart. Waiting in the bounded queue does not create a second attempt.
- Exactly one upstream attempt. Ambiguous sends are not retried by the intermediary.
- WebSocket upgrades require an allowed browser Origin. Only masked, complete
  subscription/unsubscription text messages and control frames are forwarded.
  No WebSocket transaction submission, binary messages or fragmented requests.
- WebSocket limits: 8 sessions, 30 client frames/minute/session, 256 KiB inbound
  and 8 MiB outbound/session, with a five-minute maximum lifetime.
- HTTP responses are not cached; provider errors retain numeric codes but omit
  provider diagnostic data to avoid exposing credentials.

Origin checks are browser safeguards, **not authentication**: external clients
can omit or forge Origin. Admission limits are shared by all visitors and are not
a production abuse-prevention guarantee. A malicious visitor can consume the shared
budget and deny service to others. Helius plan quotas remain applicable. Large reads
and fragmented WebSocket requests are intentionally unsupported. Health checks
verify process availability after the startup identity check, not continuous upstream
availability. Signing/rejection/reload recovery with a real wallet is separate acceptance.
The queue is strict FIFO: submissions or expensive scans can delay reads behind them.
Queue time counts toward the deadline; this favors bounded resource use over unlimited waiting.

## Verification

`pnpm test:rpc` runs isolated tests with synthetic credentials and controlled upstream
responses. `pnpm verify` includes them alongside the existing application tests/build.
Live acceptance additionally checks genesis, program account, balances and a historical
signature through the public proxy; verifies a real WebSocket subscription; and exercises
the published Desk in Chromium without mocks or transaction submissions. None of these
read-only checks establishes successful signing or transaction execution by a wallet.

## Release evidence — 2026-10-12

Runtime source commit: `66371db` (subsequent changes add regression tests and evidence).
The public manifest remains byte-identical to `config/deployment.devnet.json`.
Published image IDs:

- Web: `sha256:52f6316a3e143a400c39a2bff43238b06818bcec352b635388882a8f0f4fafa1`.
- RPC: `sha256:312aaf16c664e612c8d496538dbc42940fe1bacd6d11402c87dd4d8d856eae86`.

Public `/rpc` confirmed the devnet genesis, executable Aveo program at slot
510372987 and the known fixture transaction finalized without error. A Chromium
WebSocket session through `wss://aveoprotocol.io/rpc` received a real slot notification
and successfully unsubscribed. The 5173 forwarding endpoint still serves the same manifest.

The first full browser attempt failed with ten HTTP 429 responses and unconfirmed
matrix cells; it is retained as `/tmp/aveo-devnet-browser-goQ5u1/report-helius-first.json`.
The bounded FIFO and provider-aware pacing were added in response, not a retry of
failed transaction submissions. The second attempt passed: eight desktop/mobile
route observations, 55 protected RPC requests, zero direct public-RPC requests,
zero RPC HTTP failures, zero JavaScript errors and zero mutation requests. Both
wallet matrices had no unconfirmed/loading labels when captured. Screenshots,
videos and the report are in `/tmp/aveo-devnet-browser-goQ5u1`, with `helius-` prefixes
and `report-helius.json`. These temporary artifacts are not promised as durable storage.

The actual served browser assets and public manifest were scanned against the
private key without printing it: no match. Container listeners were verified on
loopback only. Resource regression tests pass 26/26; the application suite passes
2660 tests and the backend suite 41. Existing SQLite/tooling/Zod warnings are not
new proxy warnings. Synthetic response tests complement, not replace, the genuine
public HTTP/browser/WebSocket evidence. Real-wallet signing/rejection/reload
recovery, full security acceptance and six-scene signoff remain pending.
