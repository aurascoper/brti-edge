# Cellular production integration — revision 15

The separate executable `packages/kalshi-client/dist/cellular-production-bridge.js`
connects the existing translator, RSA-PSS signer and event-order adapter to
OBI's new verified production activation path. The dashboard displays
production readiness, accepts a separately signed operator decision, shows
the retained Day 1 start and exposes production confirmation/release and
protective cancellation. It never asks for a signing private key.

The bridge has a fixed production host and requires `environment: PRODUCTION`,
the production schema, executor role, exactly three initial manual-confirmation
slots, primary subaccount 0 and explicit BTC exchange 2. DEMO requests cannot
select production, and the DEMO executable cannot accept production requests.
Credentials enter only through private stdin; the response contains no secret.
The Python owner verifies the current accepted review, source/runtime bindings,
account/checkpoint, signed operator activation and matching W2 replica outputs
before recording reservation and handoff. This bridge is a transport component,
not a standalone governor or an alternative route around OBI.

Production supports `ping`, `submit` and protective `cancel`. An entry sends
the exact confirmed YES-book bid/ask translation as an IOC buy. The current
displayed ask, price grid, fee archive and event fee override are rechecked
by OBI before release. A single durable owner retains all unresolved risk.
Neither submit nor cancel retries automatically; acknowledgments do not invent
fills or release risk. The separate canonical GET path imports actual receipts.

OBI's service starts on loopback in management mode and reconciles before the
first request. `enable-orders` is a non-mutating preflight. Only an externally
signed, campaign/account/checkpoint/review/session-bound `activate-live` action
starts Day 1. Restart and resume preserve the original timestamp, gross losses,
terminal/VOID history and confirmation counters. The first three acknowledged
production orders require preview, confirmation and separate release. There
is no policy promotion mechanism between replicas and executor.

Set the dashboard's operator-controlled `CELLULAR_SUPERVISOR_URL` to the
reviewed foreground service (default `http://127.0.0.1:4200`). It proxies the
operator bearer token to the fixed configured destination. The existing
DEMO service remains separate. Detailed review artifact and launcher contracts
are in OBI's `docs/cellular/PRODUCTION-ACTIVATION.md` on its cellular review branch.

Validation: **21 Node tests**, the package build and web TypeScript pass without
skips. Five added tests exercise the actual production adapter and executable:
fixed host/signature, zero-fill acknowledgment, cross-environment/manual-count/
role/shard refusal, no retry and protective DELETE. OBI's **372 isolated tests**
include the actual foreground launcher, authenticated HTTP activation and
confirmation/release, runtime/evidence negative controls, lost acknowledgments,
first-three counts, restart, exact-budget admission and expired-review protection.
All order and cancellation I/O in these tests is synthetic.

Chromium exercised this dashboard component and proxy on an isolated page
against OBI's foreground synthetic service. Signed activation, confirmation,
separate release and pause captured one exchange-2 request, retained two manual
slots and the Day 1 timestamp, and produced zero page errors. The test services
were stopped; this establishes no real venue or Pi result.

No actual venue order/cancellation, Day 1 activation or Pi deployment was
performed. Actual W2 source/economics, inherited audit closures, requested
Noether review, authenticated DEMO and opening-account acceptance remain open.
The $50 allocation, $10 campaign stop, $1 fee-inclusive entry and $2 daily
loss-plus-risk cap are unchanged. T-KAL-4 remains PARTIAL; neither a passing
adapter suite nor the 14-day operations pilot proves edge.

```sh
node_modules/.bin/tsc -p packages/kalshi-client/tsconfig.json
node --test packages/kalshi-client/dist/cellular.test.js packages/kalshi-client/dist/cellular-bridge.test.js packages/kalshi-client/dist/cellular-demo-bridge.test.js packages/kalshi-client/dist/cellular-production-bridge.test.js
node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json
```
