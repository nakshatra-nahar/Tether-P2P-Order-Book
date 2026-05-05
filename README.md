# Tether - P2P Distributed Orderbook

A simplified distributed exchange in Node.js. Each node is its own process
with its own orderbook; orders propagate to all peers via Grenache RPC; a
matching engine produces fills with safe handling of concurrent submission.

## Architecture (TL;DR)

- **Single-writer-per-order**: every order has exactly one owner (the node
  where it was submitted). The owner is the only authority that can decrement
  the order's remaining quantity. Other nodes hold a replica for visibility
  but cannot mutate it.
- Takers contact the owner via RPC (`orderbook.node.<ownerId>`) to fill.
- Owners atomically decrement and broadcast (`applyUpdate`) the change.
- Idempotency via per-order monotonically-increasing `version`.

## Prerequisites

- Node.js 18+
- Two `grape` daemons (the DHT bootstrap):

```bash
npm i -g grenache-grape

# In two separate terminals:
grape --dp 20001 --aph 30001 --bn '127.0.0.1:20002'
grape --dp 20002 --aph 40001 --bn '127.0.0.1:20001'
```

## Install

```bash
npm install
```

## Run unit tests (no Grape required)

```bash
npm test
```

Tests cover the orderbook data structure, the matching engine, and the node
protocol (using an in-memory mock transport that simulates concurrent peers).

## Run the automated demo

Make sure both grapes (above) are running, then:

```bash
npm run demo
```

This spawns three nodes (alice, bob, carol) with seed scripts that produce
trades. Watch for `[trade]` lines in the output.

## Run the stress demo

A heavier scenario: 30 orders submitted concurrently across 3 nodes against
real Grape daemons. Useful as proof that the protocol survives bursty load.

```bash
npm run stress
```

You'll see live `[trade]` output as orders match, plus a summary of trade
events at the end.

## Run an interactive node

```bash
npm start -- --grape http://127.0.0.1:30001 --id alice
```

You'll get a REPL:

```
> buy 5 100
order <uuid>  fills=0  resting=5
> sell 3 99
order <uuid>  fills=1  resting=0
  filled 3 @ 100 (maker <uuid> [self])
> book
bids: 1  best=2@100
asks: 0  best=-
> mine
  <uuid>  buy 2/5 @ 100
> cancel <uuid>
cancelled <uuid>
> quit
```

Open multiple terminals, each running its own node, all pointing at the same
grape - they discover each other and exchange orders.

## Project layout

```
src/
  orderbook.js   # OrderBook data structure (pure)
  matching.js    # findCandidates (pure)
  transport.js   # Grenache wrapper
  node.js        # protocol orchestrator
  repl.js        # interactive command parser
bin/
  tether-node.js # CLI entrypoint
demo/
  demo.js        # spawns 3 nodes
  seeds/*.json   # seed scripts
test/
  *.test.js      # unit + integration tests
LIMITATIONS.md   # what's missing & how I'd extend
```

## Limitations

See `LIMITATIONS.md` for a detailed list of v1 trade-offs and how each would
be addressed with more time.
