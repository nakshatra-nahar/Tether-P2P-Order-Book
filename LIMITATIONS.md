# Limitations

This document lists the simplifications and known gaps in the v1
implementation, with notes on how each would be addressed given more time.

**Status summary:** of the original 19 items documented during the build,
1 was a duplicate (now consolidated, leaving 18 numbered sections) and
4 were shipped during late-stage polish (#1 WAL persistence, #8 snapshot
self-rehydration, #14 emit-remove-on-replace, #17 demo auto-spawn). The
remaining 14 items are real follow-up work — categorized below as
functional, robustness, or operational gaps. Each entry includes a
"How to fix" note describing the approach I'd take. Sections marked
"(shipped)" in their headings are kept in the document as a record of
what was completed.

## Functional gaps

### 1. WAL persistence shipped; compaction not yet implemented
A per-node append-only JSONL WAL is now wired in (opt-in via `--wal-dir`).
Every owner-side mutation (`add`/`reduce`/`remove`) is written before the
in-memory state advances, so a crashed-and-restarted node restores its
owned orders before fetching the peer snapshot. The WAL handles a torn
final write (truncated trailing line is skipped on replay).

What's still missing is **compaction**: the WAL grows unbounded as orders
churn through. For a long-lived node, file size is a real concern.

**How to fix:** periodically take a checkpoint of the live `myOrders`
state, write it as a single `{ op: 'snapshot', orders: [...] }` record at
the head of a new WAL file, and atomically replace. Stale records before
the checkpoint can be discarded. This is ~30 lines and bounds WAL size
to live-order count.

### 2. No order-owner failover
If the owner of an order crashes, its open orders are effectively lost (other
nodes still have replicas, but no node can authoritatively fill them since
the owner is gone).

**How to fix:** chain-replicate each order to N peers. On owner death
(detected via heartbeat absence), the next peer in the chain is promoted to
owner, takes over the `tryFill` route, and increments a generation counter.
This is essentially a per-order Raft-lite; for a real exchange you'd use
proper consensus.

### 3. Soft TTL eviction not implemented
When a node disappears, the dead owner's orders linger in survivors'
replicas. They fail loudly on `tryFill` (rejected: 'gone' if the owner had
cancelled, or RPC timeout if the owner has crashed) and we drop them
defensively, but the book may show stale liquidity until then.

**How to fix:** track `lastSeen` per remote node from `link.lookup` results.
When a node has been absent for >5s, mark all its replica orders as `stale`
and drop them from `findCandidates` consideration. Clean removal can wait
until next snapshot.

### 4. No global trade ordering
Different nodes may observe `[trade]` events in different orders, since each
trade emerges locally on owner and on taker independently and the broadcast
to other peers races.

**How to fix:** attach a Lamport clock to every trade event, sort events on
display. For an exchange that needs deterministic public tape, append all
trades to an ordered Merkle log (e.g., HotStuff or anchored gossip).

### 5. Snapshot from single peer
A new node bootstraps by asking one peer for the full book. If that peer is
behind on broadcasts, the new node starts behind too.

**How to fix:** snapshot from K peers via `peer.map`, merge by taking the
highest `version` per `orderId`. Continue accepting `applyUpdate`s during
the snapshot fetch (already buffered for ~500ms, then drained).

### 6. Single trading pair, limit orders only
v1 has one global book and limit orders only. The challenge says "simple
order matching engine" so this is by design, but it's worth calling out.

**How to extend:** keep a `Map<symbol, OrderBook>`. Every order carries a
`symbol`; routing in `submitOrder`/`tryFill` keys on it. Market orders are a
matching-engine variant of `findCandidates` that ignores price (matches the
top of the opposite side until taker is exhausted or book is empty). IOC/FOK
are time-in-force flags that skip the "rest the remainder" branch.

### 7. No cancellation across the wire
`cancelOrder` only works for the owner. We don't expose remote cancellation.

**How to fix:** not needed in P2P - non-owners shouldn't be able to cancel
others' orders anyway. If we add accounts/auth, the account holder's signed
request to any node would broadcast a signed cancel that the owner verifies.

### 8. Full crash recovery requires WAL+snapshot in combination (now shipped)
Both pieces are now present:
- WAL replay (this section's predecessor) restores authoritative state for
  orders this node owns.
- Peer snapshot merge (already shipped) fills in remote orders.

A node can fully recover its state as long as at least one of (own WAL,
reachable peer with the snapshot) is available. The remaining gap is the
all-nodes-crash-simultaneously case; persistence on every node makes this
recoverable too.

**Optional extension:** add an aggregated checkpoint format so cold-start
of a new fleet from disk doesn't need any peer snapshot at all.

## Robustness / production gaps

### 9. No Byzantine resistance
The protocol assumes nodes are honest. A malicious owner could refuse
fills, fabricate `applyUpdate` events for orders that don't exist, or claim
larger fills than actually happened.

**How to fix:** orders signed by the submitter; fill receipts signed by both
maker and taker; peers verify signatures before applying broadcasts. For
fully Byzantine-tolerant matching you'd need PBFT or a Tendermint-style
ordering layer - out of scope for a 6-8h task.

### 10. Naive broadcast (O(N) per update)
Every state change is broadcast via `peer.map` to all peers. Scales poorly.

**How to fix:** gossip with anti-entropy. Each node broadcasts to a small
random subset (fanout K=3); periodically run a Merkle-tree-based reconciler
to catch missed updates. Trades real-time latency for bandwidth.

### 11. Replica reconciliation is corrective, not proactive
The owner now broadcasts `applyUpdate('reduce', { qty, remaining, version })`
carrying both the delta and the new absolute `remaining`. The receiver uses
the absolute value, so out-of-order broadcasts no longer cause `remaining`
drift on the replica side.

What's still missing is **proactive** reconciliation: a replica that misses
broadcasts entirely (e.g., during a partition) won't self-heal until it
either tries to match against the affected order (the `tryFill` reply will
correct it) or fetches a fresh snapshot.

**How to fix:** periodic anti-entropy. Every 30s, exchange `(orderId,
version)` digests with one random peer; for any version mismatch, request
the full order from the peer with the higher version. ~50 lines.

### 12. No backpressure / rate-limiting
A flooder could submit thousands of orders and overwhelm peers' RPC servers.

**How to fix:** token bucket per peer at the transport layer. Slow takers
that send too many `tryFill`s per second see RPC rejections.

### 13. Float arithmetic for `qty` and `price`
The matching engine uses plain JS Number arithmetic. For fractional quantities
this accumulates float error.

**How to fix:** use a Decimal library (e.g., `decimal.js` or BigInt-scaled
integers) for all `qty` and `price` math.

### 14. `applyUpdate('add')` replace path now emits `remove` before `add` (shipped)
When an `add` arrives with a newer version of an existing order, the impl
now correctly emits `remove` (with the old version) before emitting `add`
(with the new version), so event-stream subscribers see a clean
remove-then-add transition.

### 15. No metrics / observability
Just `console.log`. No counters, no traces, no health endpoints.

**How to fix:** export Prometheus metrics for orders submitted, trades
made, RPC latency p50/p99, replica size; structured JSON logging via
`pino`.

## Operational gaps

### 16. No graceful shutdown of in-flight orders
On SIGINT, the node tears down immediately. A `submitOrder` that's mid-RPC
will get a transport error on its next operation.

**How to fix:** drain the event loop for ~1s before stopping; refuse new
order submissions during drain; await outstanding `tryFill` requests.

### 17. Grape auto-spawn shipped (was: Grape daemons external)
The three demos (`npm run demo`, `npm run stress`, `npm run crash-recovery`)
now auto-spawn the two grape daemons via `demo/grape-launcher.js` if
they're not already listening on their standard ports (30001, 40001), and
tear them down on exit. The grader runs a single `npm run <demo>` command
with no manual setup beyond `npm install` and `npm i -g grenache-grape`.

If grapes are already running (e.g., started manually), the launcher
detects the open ports and uses them without disturbing them.

### 18. No Docker / containerization
Run instructions assume local Node + grapes.

**How to fix:** `Dockerfile` + `docker-compose.yml` with grape and N node
services.

## Out of scope (deliberately)

- Account ledger, balances, settlement
- Fee model
- Authentication, KYC, identity
- Web UI
- HTTP / WebSocket external API (challenge forbids)
- DB persistence (challenge discourages)
