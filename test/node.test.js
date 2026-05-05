'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Node } = require('../src/node')

// In-memory mock transport. Each instance registers under a 'directory'
// shared across all instances. request/broadcast deliver via direct
// method calls so tests are deterministic.
class Directory {
  constructor () { this.byService = new Map() }
  register (service, transport) {
    if (!this.byService.has(service)) this.byService.set(service, [])
    this.byService.get(service).push(transport)
  }
  unregister (transport) {
    for (const arr of this.byService.values()) {
      const i = arr.indexOf(transport)
      if (i >= 0) arr.splice(i, 1)
    }
  }
  pick (service) {
    const arr = this.byService.get(service)
    return arr && arr.length ? arr[0] : null
  }
  all (service) {
    return [...(this.byService.get(service) || [])]
  }
}

class MockTransport {
  constructor (directory) {
    this.directory = directory
    this._handler = null
    this._announces = new Set()
  }
  start () {}
  announce (name) {
    if (this._announces.has(name)) return
    this._announces.add(name)
    this.directory.register(name, this)
  }
  unannounce (name) {
    this._announces.delete(name)
  }
  onRequest (h) { this._handler = h }
  async request (service, payload, opts) {
    const target = this.directory.pick(service)
    if (!target) throw new Error('no-peer:' + service)
    return await target._handler(payload)
  }
  async broadcast (service, payload) {
    const targets = this.directory.all(service)
    const data = []
    for (const t of targets) {
      try { data.push(await t._handler(payload)) }
      catch (e) { /* swallow */ }
    }
    return { err: null, data }
  }
  stop () { this.directory.unregister(this) }
}

async function makeNode (directory, id) {
  const transport = new MockTransport(directory)
  transport.start()
  const node = new Node({ nodeId: id, transport })
  await node.start({ skipSnapshotDelay: true })
  return node
}

test('submitting on an empty book rests the full order', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const r = await a.submitOrder({ side: 'buy', price: 100, qty: 5 })
  assert.equal(r.fills.length, 0)
  assert.equal(r.restingRemainder, 5)
  assert.equal(a.book.bids.length, 1)
  await a.stop()
})

test('two nodes: taker fully fills maker, no remainder rests', async () => {
  const dir = new Directory()
  const maker = await makeNode(dir, 'M')
  const taker = await makeNode(dir, 'T')
  await maker.submitOrder({ side: 'sell', price: 99, qty: 10 })
  await new Promise(r => setImmediate(r))

  const r = await taker.submitOrder({ side: 'buy', price: 100, qty: 5 })
  assert.equal(r.fills.length, 1)
  assert.equal(r.fills[0].qty, 5)
  assert.equal(r.fills[0].price, 99)
  assert.equal(r.restingRemainder, 0)

  const makerOrder = [...maker.myOrders.values()][0]
  assert.equal(makerOrder.remaining, 5)
  await maker.stop(); await taker.stop()
})

test('taker partially fills, remainder rests on taker', async () => {
  const dir = new Directory()
  const maker = await makeNode(dir, 'M')
  const taker = await makeNode(dir, 'T')
  await maker.submitOrder({ side: 'sell', price: 99, qty: 3 })
  await new Promise(r => setImmediate(r))

  const r = await taker.submitOrder({ side: 'buy', price: 100, qty: 5 })
  assert.equal(r.fills.length, 1)
  assert.equal(r.fills[0].qty, 3)
  assert.equal(r.restingRemainder, 2)
  assert.equal(maker.myOrders.size, 0)
  assert.equal(taker.myOrders.size, 1)
  await maker.stop(); await taker.stop()
})

test('non-crossing price does not match', async () => {
  const dir = new Directory()
  const maker = await makeNode(dir, 'M')
  const taker = await makeNode(dir, 'T')
  await maker.submitOrder({ side: 'sell', price: 105, qty: 5 })
  await new Promise(r => setImmediate(r))

  const r = await taker.submitOrder({ side: 'buy', price: 100, qty: 5 })
  assert.equal(r.fills.length, 0)
  assert.equal(r.restingRemainder, 5)
  await maker.stop(); await taker.stop()
})

test('self-match: own buy crosses own sell', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  await a.submitOrder({ side: 'sell', price: 99, qty: 4 })
  const r = await a.submitOrder({ side: 'buy', price: 100, qty: 5 })
  assert.equal(r.fills.length, 1)
  assert.equal(r.fills[0].qty, 4)
  assert.equal(r.fills[0].self, true)
  assert.equal(r.restingRemainder, 1)
  await a.stop()
})

test('cancel removes own order', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const { orderId } = await a.submitOrder({ side: 'buy', price: 100, qty: 5 })
  const c = a.cancelOrder(orderId)
  assert.equal(c.cancelled, true)
  assert.equal(a.book.bids.length, 0)
  assert.equal(a.myOrders.size, 0)
  await a.stop()
})

test('cancel rejects unknown order id', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  assert.throws(() => a.cancelOrder('nope'), /not-your-order/)
  await a.stop()
})

test('applyUpdate is idempotent on stale version', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const order = {
    id: 'x', ownerNodeId: 'B', side: 'buy', price: 100,
    qty: 5, remaining: 5, ts: 1, version: 5
  }
  await a._handleRpc({ type: 'applyUpdate', op: 'add', order, version: 5 })
  await a._handleRpc({ type: 'applyUpdate', op: 'add', order: { ...order, version: 3 }, version: 3 })
  assert.equal(a.book.get('x').version, 5)
  await a.stop()
})

test('tryFill rejects unknown order with reason gone', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const r = await a._handleRpc({
    type: 'tryFill', makerOrderId: 'nope',
    takerOrderId: 't', takerNodeId: 'T', price: 100, qty: 5
  })
  assert.equal(r.rejected, true)
  assert.equal(r.reason, 'gone')
  await a.stop()
})

test('tryFill rejects on price-no-cross', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  // Maker is a sell at 100. A "buy" taker at 99 does NOT cross (99 < 100).
  const { orderId } = await a.submitOrder({ side: 'sell', price: 100, qty: 5 })
  const r = await a._handleRpc({
    type: 'tryFill', makerOrderId: orderId,
    takerOrderId: 't', takerNodeId: 'T',
    price: 99,
    qty: 1
  })
  assert.equal(r.rejected, true)
  assert.equal(r.reason, 'price-no-cross')
  await a.stop()
})

test('tryFill - concurrent calls serialized: total filled <= maker qty', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const { orderId } = await a.submitOrder({ side: 'buy', price: 100, qty: 10 })
  const make = () => a._handleRpc({
    type: 'tryFill', makerOrderId: orderId,
    takerOrderId: 't' + Math.random(), takerNodeId: 'T',
    price: 99, qty: 5
  })
  const results = await Promise.all([make(), make(), make()])
  const totalFilled = results.reduce((s, r) => s + (r.filled || 0), 0)
  assert.equal(totalFilled, 10)
  assert.equal(a.myOrders.size, 0)
  await a.stop()
})

test('three-node scenario: maker sells, two takers race, total filled equals maker qty', async () => {
  const dir = new Directory()
  const maker = await makeNode(dir, 'M')
  const t1 = await makeNode(dir, 'T1')
  const t2 = await makeNode(dir, 'T2')
  await maker.submitOrder({ side: 'sell', price: 99, qty: 10 })
  await new Promise(r => setImmediate(r))

  const [r1, r2] = await Promise.all([
    t1.submitOrder({ side: 'buy', price: 100, qty: 7 }),
    t2.submitOrder({ side: 'buy', price: 100, qty: 7 })
  ])
  const f1 = r1.fills.reduce((s, f) => s + f.qty, 0)
  const f2 = r2.fills.reduce((s, f) => s + f.qty, 0)
  assert.equal(f1 + f2, 10)
  assert.equal(r1.restingRemainder + r2.restingRemainder, 4)
  await maker.stop(); await t1.stop(); await t2.stop()
})

test('applyUpdate received before _ready is buffered and replayed', async () => {
  // Manually construct a node so we can interleave _handleRpc with start()
  const dir = new Directory()
  const transport = new MockTransport(dir)
  transport.start()
  const node = new Node({ nodeId: 'X', transport })

  // Send an applyUpdate BEFORE start() - _ready is false
  const order = {
    id: 'preboot', ownerNodeId: 'Y', side: 'sell', price: 99,
    qty: 4, remaining: 4, ts: 1, version: 1
  }
  const r1 = await node._handleRpc({ type: 'applyUpdate', op: 'add', order, version: 1 })
  assert.equal(r1.buffered, true)
  // Book is still empty (update was buffered, not applied)
  assert.equal(node.book.bids.length + node.book.asks.length, 0)

  // Now run start() - should drain the buffer
  await node.start({ skipSnapshotDelay: true })
  assert.equal(node.book.asks.length, 1)
  assert.equal(node.book.get('preboot').version, 1)

  await node.stop()
})

test('submitOrder drops a candidate when its owner times out and tries the next one', async () => {
  const dir = new Directory()
  // Maker M1 will be flaky (its tryFill throws). Maker M2 is healthy.
  const m1 = await makeNode(dir, 'M1')
  const m2 = await makeNode(dir, 'M2')
  const taker = await makeNode(dir, 'T')

  // Patch m1's transport to throw on any tryFill request after this point
  const originalHandler = m1.transport._handler
  m1.transport._handler = async (payload) => {
    if (payload && payload.type === 'tryFill') throw new Error('simulated-timeout')
    return originalHandler(payload)
  }

  // Both makers rest sells; m1 best (lowest price), m2 next
  await m1.submitOrder({ side: 'sell', price: 99, qty: 5 })
  await new Promise(r => setImmediate(r))
  await m2.submitOrder({ side: 'sell', price: 100, qty: 5 })
  await new Promise(r => setImmediate(r))

  // Taker buys 3 - should hit m1 first, fail, drop, then hit m2 successfully
  const r = await taker.submitOrder({ side: 'buy', price: 100, qty: 3 })
  assert.equal(r.fills.length, 1)
  assert.equal(r.fills[0].ownerNodeId, 'M2')
  assert.equal(r.fills[0].qty, 3)
  // m1's order is now dropped from taker's local replica (defensive removal)
  assert.equal(taker.book.get([...m1.myOrders.values()][0].id), null)

  await m1.stop(); await m2.stop(); await taker.stop()
})

test('tryFill via wrong service name is rejected', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const { orderId } = await a.submitOrder({ side: 'buy', price: 100, qty: 5 })
  // Pass a wrong service name as the second arg to _handleRpc
  const r = await a._handleRpc({
    type: 'tryFill', makerOrderId: orderId,
    takerOrderId: 't', takerNodeId: 'T',
    price: 99, qty: 1
  }, 'orderbook')  // wrong - must be orderbook.node.A
  assert.equal(r.rejected, true)
  assert.equal(r.reason, 'wrong-service')
  await a.stop()
})

test('tryFill via correct owner-specific service name succeeds', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const { orderId } = await a.submitOrder({ side: 'buy', price: 100, qty: 5 })
  const r = await a._handleRpc({
    type: 'tryFill', makerOrderId: orderId,
    takerOrderId: 't', takerNodeId: 'T',
    price: 99, qty: 1
  }, 'orderbook.node.A')
  assert.equal(r.filled, 1)
  await a.stop()
})

test('applyUpdate(reduce) uses absolute remaining when provided', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const order = {
    id: 'x', ownerNodeId: 'B', side: 'buy', price: 100,
    qty: 10, remaining: 10, ts: 1, version: 1
  }
  // First, add the order to a's replica
  await a._handleRpc({ type: 'applyUpdate', op: 'add', order, version: 1 })
  assert.equal(a.book.get('x').remaining, 10)

  // Send a reduce with absolute remaining=4
  await a._handleRpc({
    type: 'applyUpdate', op: 'reduce', orderId: 'x',
    qty: 6, remaining: 4, version: 2
  })
  assert.equal(a.book.get('x').remaining, 4)
  assert.equal(a.book.get('x').version, 2)
  await a.stop()
})

test('applyUpdate(reduce) with absolute remaining=0 removes the order', async () => {
  const dir = new Directory()
  const a = await makeNode(dir, 'A')
  const order = {
    id: 'x', ownerNodeId: 'B', side: 'buy', price: 100,
    qty: 5, remaining: 5, ts: 1, version: 1
  }
  await a._handleRpc({ type: 'applyUpdate', op: 'add', order, version: 1 })
  await a._handleRpc({
    type: 'applyUpdate', op: 'reduce', orderId: 'x',
    qty: 5, remaining: 0, version: 2
  })
  assert.equal(a.book.get('x'), null)
  await a.stop()
})

test('stress: 20 takers race for one maker, total filled equals maker qty exactly', async () => {
  const dir = new Directory()
  const maker = await makeNode(dir, 'M')
  const takers = []
  for (let i = 0; i < 20; i++) {
    takers.push(await makeNode(dir, 'T' + i))
  }

  // Maker rests sell 100@99
  await maker.submitOrder({ side: 'sell', price: 99, qty: 100 })
  // Let broadcasts propagate
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))

  // 20 takers each try to buy 10 at price 100. Total demand = 200, supply = 100.
  const results = await Promise.all(takers.map(t =>
    t.submitOrder({ side: 'buy', price: 100, qty: 10 })
  ))

  const totalFilled = results.reduce((s, r) =>
    s + r.fills.reduce((a, f) => a + f.qty, 0), 0)
  const totalRemainder = results.reduce((s, r) => s + r.restingRemainder, 0)

  // CRITICAL: under 20-way concurrency, total fills must NEVER exceed maker qty.
  assert.equal(totalFilled, 100, 'total filled must equal maker qty exactly')
  // Conservation per order: filled + resting = original qty
  for (const r of results) {
    const filled = r.fills.reduce((s, f) => s + f.qty, 0)
    assert.equal(filled + r.restingRemainder, 10)
  }
  // Total demand = supply + leftover resting
  assert.equal(totalFilled + totalRemainder, 200)
  // Maker fully consumed
  assert.equal(maker.myOrders.size, 0)

  await maker.stop()
  for (const t of takers) await t.stop()
})

test('stress: 50 random orders across 3 nodes preserve conservation invariants', async () => {
  const dir = new Directory()
  const nodes = []
  for (let i = 0; i < 3; i++) {
    nodes.push(await makeNode(dir, 'N' + i))
  }

  // Subscribe to trade events on every node BEFORE submitting any orders.
  // Every cross-node match emits one 'maker' event and one 'taker' event
  // with the same qty; self-matches emit one 'self' event.
  const trades = []
  for (const node of nodes) {
    node.on('trade', (t) => trades.push(t))
  }

  // Generate 50 deterministic-but-varied orders.
  const submissions = []
  for (let i = 0; i < 50; i++) {
    submissions.push({
      nodeIdx: i % 3,
      side: i % 2 === 0 ? 'buy' : 'sell',
      price: 95 + (i % 11),     // 95..105
      qty: 5 + (i % 10)         // 5..14
    })
  }

  // Submit all 50 concurrently across the 3 nodes
  const tasks = submissions.map(s =>
    nodes[s.nodeIdx].submitOrder({ side: s.side, price: s.price, qty: s.qty })
  )
  const results = await Promise.all(tasks)

  // Let any in-flight broadcasts settle
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))

  // Invariant 1 (per-order conservation, taker-side):
  // For each submitted order, the fills it triggered as a taker plus what
  // remained as resting must equal its original quantity. (Note: an order
  // that rests can be filled later by a different taker; that later fill
  // is captured in the OTHER submission's result, not this one's.)
  for (let i = 0; i < submissions.length; i++) {
    const r = results[i]
    const orig = submissions[i]
    const filled = r.fills.reduce((s, f) => s + f.qty, 0)
    assert.equal(filled + r.restingRemainder, orig.qty,
      'order ' + i + ' (side=' + orig.side + ' qty=' + orig.qty + '): filled+resting=' +
      (filled + r.restingRemainder) + ' but qty=' + orig.qty)
  }

  // Invariant 2 (cross-node match conservation, via trade events):
  // For every cross-node trade, one node emits 'maker' and the other
  // emits 'taker' with the same qty. So summing across all nodes:
  //   total maker-role qty === total taker-role qty
  const makerVol = trades.filter(t => t.role === 'maker').reduce((s, t) => s + t.qty, 0)
  const takerVol = trades.filter(t => t.role === 'taker').reduce((s, t) => s + t.qty, 0)
  assert.equal(makerVol, takerVol,
    'cross-node match conservation: maker-role volume (' + makerVol +
    ') must equal taker-role volume (' + takerVol + ')')

  // Invariant 3: every order in any node's myOrders is also in that node's
  // book at the same reference. This catches drift between local-ownership
  // tracking and the replica.
  for (const node of nodes) {
    for (const order of node.myOrders.values()) {
      const inBook = node.book.get(order.id)
      assert.ok(inBook, 'node ' + node.nodeId + ' has myOrder ' + order.id + ' missing from book')
      assert.equal(inBook, order, 'myOrder and book entry must be the same reference')
      assert.ok(order.remaining > 0, 'resting order must have positive remaining')
    }
  }

  // Invariant 4: no order has non-positive remaining anywhere
  // (decrement-to-zero must remove, not leave at zero).
  for (const node of nodes) {
    for (const o of node.book.snapshot()) {
      assert.ok(o.remaining > 0,
        'order ' + o.id + ' on node ' + node.nodeId + ' has remaining ' + o.remaining)
    }
  }

  // Sanity: at least SOME trading happened (otherwise the test is trivial)
  assert.ok(trades.length > 0, 'expected some trades from 50 random orders; got 0')

  for (const node of nodes) await node.stop()
})

test('WAL: a node restarts from disk and recovers its owned orders', async () => {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const { Wal } = require('../src/wal')
  const walDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-wal-it-'))

  // First incarnation: writes WAL
  const dir1 = new Directory()
  const transport1 = new MockTransport(dir1)
  transport1.start()
  const wal1 = new Wal({ dir: walDir, nodeId: 'PERSIST' })
  const node1 = new Node({ nodeId: 'PERSIST', transport: transport1, wal: wal1 })
  await node1.start({ skipSnapshotDelay: true })

  const r1 = await node1.submitOrder({ side: 'buy', price: 100, qty: 5 })
  const r2 = await node1.submitOrder({ side: 'sell', price: 110, qty: 3 })
  // Self-match attempt: would NOT cross (buy 100 vs sell 110), so both rest
  assert.equal(r1.restingRemainder, 5)
  assert.equal(r2.restingRemainder, 3)
  assert.equal(node1.myOrders.size, 2)

  await node1.stop()

  // Second incarnation: restarts with same WAL dir + nodeId, fresh transport
  const dir2 = new Directory()
  const transport2 = new MockTransport(dir2)
  transport2.start()
  const wal2 = new Wal({ dir: walDir, nodeId: 'PERSIST' })
  const node2 = new Node({ nodeId: 'PERSIST', transport: transport2, wal: wal2 })
  await node2.start({ skipSnapshotDelay: true })

  // Both orders should be back in myOrders AND book
  assert.equal(node2.myOrders.size, 2)
  assert.ok(node2.myOrders.has(r1.orderId))
  assert.ok(node2.myOrders.has(r2.orderId))
  assert.equal(node2.book.bids.length, 1)
  assert.equal(node2.book.asks.length, 1)
  assert.equal(node2.book.get(r1.orderId).remaining, 5)
  assert.equal(node2.book.get(r2.orderId).remaining, 3)

  await node2.stop()
})

test('WAL: replays reduce records correctly', async () => {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const { Wal } = require('../src/wal')
  const walDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-wal-it-'))

  // First node: maker that gets partially filled
  const dir1 = new Directory()
  const transport1 = new MockTransport(dir1)
  transport1.start()
  const wal1 = new Wal({ dir: walDir, nodeId: 'M' })
  const maker = new Node({ nodeId: 'M', transport: transport1, wal: wal1 })
  await maker.start({ skipSnapshotDelay: true })

  const transport2 = new MockTransport(dir1)
  transport2.start()
  const taker = new Node({ nodeId: 'T', transport: transport2 })
  await taker.start({ skipSnapshotDelay: true })

  // Maker rests sell 10@99
  const r = await maker.submitOrder({ side: 'sell', price: 99, qty: 10 })
  await new Promise(r => setImmediate(r))

  // Taker buys 6 — partial fill on maker
  await taker.submitOrder({ side: 'buy', price: 100, qty: 6 })
  // Maker should have 4 remaining
  assert.equal(maker.myOrders.get(r.orderId).remaining, 4)

  await maker.stop()
  await taker.stop()

  // Restart maker only
  const dir3 = new Directory()
  const transport3 = new MockTransport(dir3)
  transport3.start()
  const wal3 = new Wal({ dir: walDir, nodeId: 'M' })
  const maker2 = new Node({ nodeId: 'M', transport: transport3, wal: wal3 })
  await maker2.start({ skipSnapshotDelay: true })

  // After WAL replay, the order should reflect the post-fill state (4 remaining)
  assert.equal(maker2.myOrders.size, 1)
  assert.equal(maker2.myOrders.get(r.orderId).remaining, 4)

  await maker2.stop()
})
