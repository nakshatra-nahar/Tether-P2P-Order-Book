# Limitations

This document lists the simplifications and known gaps in the v1
implementation, with notes on how each would be addressed given more time.

## Functional gaps

### 1. No persistence
Orders live in memory. If a node crashes, its open orders are lost.

**How to fix:** add a per-node append-only WAL (write-ahead log) in JSONL.
Append every owner-side mutation (`add`/`reduce`/`remove`) before
broadcasting; on startup, replay the WAL into `myOrders` and `book` before
fetching the snapshot.

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

**How to fix:** not needed in P2P — non-owners shouldn't be able to cancel
others' orders anyway. If we add accounts/auth, the account holder's signed
request to any node would broadcast a signed cancel that the owner verifies.

### 8. Snapshot replay restores self-owned orders, but no WAL exists
On startup, when a node fetches a snapshot it now correctly registers
self-owned orders (`order.ownerNodeId === this.nodeId`) into `myOrders` —
so a restarted node with the same `nodeId` will continue to own its prior
orders if peers are still around to provide the snapshot.

This is **not** the same as full crash recovery. If ALL nodes crash and
restart simultaneously, no peer holds the snapshot, and the orders are lost
because nothing was persisted.

**How to fix:** combine the now-implemented snapshot-rehydration with a
per-node WAL (see #1). On startup, replay WAL into `myOrders`/`book` first,
then merge the peer snapshot to fill in remote orders. This gives full
self-recovery as long as at least one of (own WAL, peer snapshot) is
available.

## Robustness / production gaps

### 9. No Byzantine resistance
The protocol assumes nodes are honest. A malicious owner could refuse
fills, fabricate `applyUpdate` events for orders that don't exist, or claim
larger fills than actually happened.

**How to fix:** orders signed by the submitter; fill receipts signed by both
maker and taker; peers verify signatures before applying broadcasts. For
fully Byzantine-tolerant matching you'd need PBFT or a Tendermint-style
ordering layer — out of scope for a 6-8h task.

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

What's still missing is *proactive* reconciliation: a replica that misses
broadcasts entirely (e.g., during a partition) won't self-heal until it
either tries to match against the affected order (the `tryFill` reply will
correct it) or fetches a fresh snapshot.

**How to fix:** periodic anti-entropy. Every 30s, exchange `(orderId,
version)` digests with one random peer; for any version mismatch, request
the full order from the peer with the higher version.

### 12. No proactive replica reconciliation
We only correct stale replicas via `tryFill` reply errors and snapshots on
join. A replica can drift indefinitely if it doesn't try to match.

**How to fix:** periodic anti-entropy: every 30s, exchange `(orderId,
version)` digests with one random peer, repair mismatches.

### 13. No backpressure / rate-limiting
A flooder could submit thousands of orders and overwhelm peers' RPC servers.

**How to fix:** token bucket per peer at the transport layer. Slow takers
that send too many `tryFill`s per second see RPC rejections.

### 14. Float arithmetic for `qty` and `price`
The matching engine uses plain JS Number arithmetic. For fractional quantities
this accumulates float error.

**How to fix:** use a Decimal library (e.g., `decimal.js` or BigInt-scaled
integers) for all `qty` and `price` math.

### 15. `applyUpdate('add')` replace path doesn't emit `remove`
When an `add` arrives with a newer version of an existing order, the impl
removes-then-adds but only emits `add`. UI subscribers tracking by events
alone may double-count or miss the replacement.

**How to fix:** emit a `remove` before the `add` when replacing.

### 16. No metrics / observability
Just `console.log`. No counters, no traces, no health endpoints.

**How to fix:** export Prometheus metrics for orders submitted, trades
made, RPC latency p50/p99, replica size; structured JSON logging via
`pino`.

## Operational gaps

### 17. No graceful shutdown of in-flight orders
On SIGINT, the node tears down immediately. A `submitOrder` that's mid-RPC
will get a transport error on its next operation.

**How to fix:** drain the event loop for ~1s before stopping; refuse new
order submissions during drain; await outstanding `tryFill` requests.

### 18. Grape daemons are external
Per the challenge, grapes run separately; the demo expects them to be up.
The demo could spawn them itself for fully one-command operation.

**How to fix:** detect grape on standard ports; spawn them as child
processes if absent; tear down at end. Skipped to keep the demo small.

### 19. No Docker / containerization
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
