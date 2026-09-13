# Cellular demo integration — revision 10

The isolated cellular adapter now has a one-request executable,
`packages/kalshi-client/dist/cellular-demo-bridge.js`, consumed by OBI's
`cellular_engine.demo.BrtiDemoVenue`. The existing translation-only bridge
remains credential-free. The new bridge takes credentials through a private
stdin pipe, never an environment lookup or command-line PEM, and emits only
an account-bound readiness/acknowledgment result or a generic refusal.

The private protocol supports `ping` and `submit`, always with environment
DEMO, executor role and at least three manual-confirmation slots configured.
The OBI ledger owns the actual persisted counter and preview confirmation.
This adapter is not a standalone governor and must only be called after that
owner has durably reserved the exact request and recorded its submission intent.

`submit` invokes the real `CellularDemoAdapter`, RSA-PSS signer and fetch path.
It uses the fixed [Kalshi demo host](https://docs.kalshi.com/getting_started/api_environments)
and [V2 event-order endpoint](https://docs.kalshi.com/api-reference/orders/create-order-v2).
The exact preview wire carries YES-book bid/ask price, whole count, IOC,
post-only false, primary subaccount 0 and explicit exchange index 0. Other
shards, reduce-only orders and foreign subaccounts are refused by this entry
bridge. A supplied submission deadline is checked after signing and immediately
before fetch. The OBI owner derives it from proposal expiry and account freshness.

HTTP 201 and a valid matching client/order acknowledgment are required. IOC
remaining count must be zero; filled count cannot exceed the requested count.
An acknowledgment does not synthesize fill or fee receipts. The OBI durable
GET reconciler imports those separately. A timeout, malformed reply or rejection
is not retried; the owner keeps risk until reconciliation. No arbitrary base
URL or production switch is exposed by this bridge.

The added `exchange_index: 0` wire field tightens routing. Rebuild both bridge
consumers together. An unreleased preview made by the older translator will
fail the exact-wire comparison; cancel that held preview and prepare a fresh
one. Reserved/ambiguous orders remain in their original journal for resolution.
Do not reset a ledger or its confirmation counters to accommodate this change.

Validation: the package TypeScript build and **12 Node tests** pass with zero
skips. Five new tests exercise the actual adapter, signature verification,
deadline/host/scope refusal, HTTP errors, no retry, acknowledgment contracts and
the executable's private-input/error boundary. OBI additionally exercises the
full confirmation/reservation/bridge/reconciliation path using a fake fetch
boundary and separate API-shaped account observations.

No authenticated demo order was submitted in this revision. A demo credential,
adopted demo opening checkpoint and operator-selected mechanics session remain
necessary for venue acceptance. W2 source/economics, inherited audit closures
and requested Noether review remain unaccepted; this mechanics adapter does not
import the closed maker or establish strategy edge.

```bash
node_modules/.bin/tsc -p packages/kalshi-client/tsconfig.json
node --test packages/kalshi-client/dist/cellular.test.js packages/kalshi-client/dist/cellular-bridge.test.js packages/kalshi-client/dist/cellular-demo-bridge.test.js
```
