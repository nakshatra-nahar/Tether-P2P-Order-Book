# Tether — P2P Distributed Orderbook

A simplified distributed exchange in Node.js. Each node is its own process
with its own orderbook; orders propagate to all peers via Grenache RPC; a
matching engine produces fills with safe handling of concurrent submission.

## Quick start

```bash
npm install
npm test                # 52 tests, ~80ms
npm run demo            # 3 nodes, auto-spawns grapes, prints [trade] events
npm run stress          # 30 concurrent orders across 3 nodes
npm run crash-recovery  # demonstrates WAL persistence across SIGKILL
```

The demos auto-spawn the two `grape` DHT daemons if they aren't already
running, and tear them down on exit. You only need `grenache-grape`
installed globally (see Prerequisites).

## Architecture (TL;DR)

- **Single-writer-per-order**: every order has exactly one owner (the node
  where it was submitted). The owner is the only authority that can decrement
  the order's remaining quantity. Other nodes hold a replica for visibility
  but cannot mutate it. This is the answer to the brief's "beware of race
  conditions" warning — atomic serialization comes for free from the JS
  event loop on the owner.
- **RPC routing**: takers contact the owner via `orderbook.node.<ownerId>`.
  Owners atomically decrement, broadcast the new state via `applyUpdate`,
  and reply to the taker with the confirmed fill.
- **Idempotency**: every order carries a monotonically-increasing `version`;
  receivers ignore out-of-order or duplicate updates.
- **Persistence**: opt-in WAL (`--wal-dir`) writes every owner-side mutation
  to disk before the broadcast, so a crashed node can replay and recover
  its owned orders on restart, before the peer-snapshot merge fills in
  remote orders.

Full design: `docs/superpowers/specs/2026-05-06-tether-p2p-orderbook-design.md`.

## Prerequisites

- Node.js 18+
- `grenache-grape` installed globally:

```bash
npm i -g grenache-grape
```

The demos auto-start grape daemons if they aren't already running. To run
grapes manually (e.g. for interactive nodes that span multiple terminals),
start them yourself in two separate terminals:

```bash
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

52 tests across orderbook, matching, transport, node-protocol (with an
in-memory mock transport for deterministic concurrency tests), and WAL.
Two stress tests verify safety under load: one with 20 takers racing for
a single maker, one with 50 random orders across 3 nodes asserting
conservation invariants via trade-event accounting.

## Run the automated demo

```bash
npm run demo
```

Spawns three nodes (alice, bob, carol) with seed scripts that produce
trades. Watch for `[trade]` lines in the output. Auto-spawns grapes.

## Run the stress demo

A heavier scenario: 30 orders submitted across 3 nodes in 10 rounds with
inter-round delays so broadcasts propagate. Designed to produce
predominantly cross-node trades.

```bash
npm run stress
```

You'll see live `[trade]` output as orders match, plus a summary
breakdown of cross-node vs self-match events at the end.

## Run the crash-recovery demo

Visibly demonstrates WAL persistence: spawns a node with a temporary WAL
directory, submits 3 orders, kills it with SIGKILL, restarts a fresh
process with the same `--id` and `--wal-dir`, and confirms the orders
are recovered from disk (same `orderId`s, same `remaining` quantities).

```bash
npm run crash-recovery
```

## Run an interactive node

```bash
npm start -- --grape http://127.0.0.1:30001 --id alice
```

For crash-recovery support, pass `--wal-dir <path>`:

```bash
npm start -- --grape http://127.0.0.1:30001 --id alice --wal-dir ./wal
```

Every owner-side mutation is appended to `./wal/alice.wal`; on restart
with the same `--id` and `--wal-dir`, the node replays the log and
recovers its owned orders.

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

Open multiple terminals, each running its own node, all pointing at the
same grape — they discover each other and exchange orders.

## Project layout

```
src/
  orderbook.js   # OrderBook data structure (pure)
  matching.js    # findCandidates (pure function)
  transport.js   # Grenache wrapper (Link + PeerRPCServer + PeerRPCClient)
  node.js        # protocol orchestrator (single-writer-per-order, race-safe)
  repl.js        # interactive command parser
  wal.js         # append-only JSONL write-ahead log
bin/
  tether-node.js # CLI entrypoint (--grape, --id, --seed, --wal-dir, --no-repl)
demo/
  demo.js            # 3-node seeded demo
  stress.js          # 30-order concurrent stress demo
  crash-recovery.js  # WAL persistence demo
  grape-launcher.js  # auto-spawn helper used by all demos
  seeds/*.json       # seed scripts for the 3-node demo
test/
  orderbook.test.js  # 14 tests
  matching.test.js   # 11 tests
  node.test.js       # 22 tests (including stress + WAL integration)
  wal.test.js        # 5 tests
LIMITATIONS.md       # documented trade-offs and how I'd extend each
```

## Limitations

See `LIMITATIONS.md` for the full list of v1 trade-offs and the approach
I'd take to address each. The brief explicitly says limitations are fine
as long as they're documented; the file lays out 18 numbered items
(4 shipped during late-stage polish, 14 real follow-up work), separated
from the items the brief said weren't needed.
