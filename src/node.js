'use strict'

const { EventEmitter } = require('events')
const { randomUUID } = require('crypto')
const { OrderBook } = require('./orderbook')
const { findCandidates, crosses } = require('./matching')

class Node extends EventEmitter {
  constructor ({ nodeId, transport, wal = null }) {
    super()
    this.nodeId = nodeId || randomUUID()
    this.transport = transport
    this.wal = wal
    this.book = new OrderBook()
    this.myOrders = new Map()
    this._snapshotBuffer = []
    this._ready = false
  }

  async start ({ skipSnapshotDelay = false, snapshotDelayMs = 500 } = {}) {
    this.transport.onRequest((payload, key) => this._handleRpc(payload, key))
    this.transport.announce('orderbook')
    this.transport.announce('orderbook.node.' + this.nodeId)

    // Replay WAL BEFORE peer snapshot — restores authoritative state for
    // orders this node owns. Peer snapshot then fills in remote orders.
    if (this.wal) {
      this.wal.replay((record) => this._applyWalRecord(record))
    }

    if (!skipSnapshotDelay) await new Promise(r => setTimeout(r, snapshotDelayMs))

    try {
      const snap = await this.transport.request(
        'orderbook',
        { type: 'snapshot' },
        { timeout: 1500 }
      )
      if (snap && snap.orders) {
        for (const o of snap.orders) {
          if (!this.book.get(o.id)) {
            const copy = { ...o }
            this.book.add(copy)
            // Re-establish ownership for orders this node had submitted before restart.
            if (copy.ownerNodeId === this.nodeId) {
              this.myOrders.set(copy.id, copy)
            }
          }
        }
      }
    } catch (_) {
      // No peers yet, or self-RPC race; start with empty book.
    }

    this._ready = true
    const buf = this._snapshotBuffer
    this._snapshotBuffer = []
    for (const u of buf) this._applyUpdate(u)
  }

  async stop () {
    try { this.transport.stop() } catch (_) {}
  }

  _applyWalRecord (record) {
    const { op } = record
    if (op === 'add') {
      const order = { ...record.order }
      this.myOrders.set(order.id, order)
      this.book.add(order)
      return
    }
    if (op === 'reduce') {
      const o = this.myOrders.get(record.orderId)
      if (!o) return
      const delta = o.remaining - record.remaining
      if (delta > 0) this.book.decrement(record.orderId, delta)
      o.version = record.version
      if (o.remaining <= 0) this.myOrders.delete(record.orderId)
      return
    }
    if (op === 'remove') {
      const o = this.myOrders.get(record.orderId)
      if (!o) return
      this.myOrders.delete(record.orderId)
      this.book.remove(record.orderId)
    }
  }

  async _handleRpc (payload, key) {
    if (!payload || !payload.type) return { error: 'malformed' }

    if (payload.type === 'snapshot') {
      return { orders: this.book.snapshot() }
    }

    if (payload.type === 'applyUpdate') {
      if (!this._ready) {
        this._snapshotBuffer.push(payload)
        return { buffered: true }
      }
      this._applyUpdate(payload)
      return { ok: true }
    }

    if (payload.type === 'tryFill') {
      // tryFill is ONLY honored when routed to this node's owner-specific service.
      // The taker MUST address us at orderbook.node.<this.nodeId>.
      if (key && key !== 'orderbook.node.' + this.nodeId) {
        return { rejected: true, reason: 'wrong-service' }
      }
      return this._handleTryFill(payload)
    }

    return { error: 'unknown-type' }
  }

  _applyUpdate (payload) {
    const { op, orderId, qty, order, version } = payload
    const current = this.book.get(orderId || (order && order.id))

    if (op === 'add') {
      if (current && current.version >= version) return
      if (current) this.book.remove(current.id)
      this.book.add({ ...order })
      this.emit('add', { ...order })
      return
    }
    if (op === 'reduce') {
      if (!current || current.version >= version) return
      const remaining = payload.remaining
      if (typeof remaining === 'number') {
        // Absolute-state path (preferred): set remaining directly.
        const delta = current.remaining - remaining
        if (delta > 0) this.book.decrement(orderId, delta)
        if (remaining <= 0) this.book.remove(orderId)
        const after = this.book.get(orderId)
        if (after) after.version = version
      } else {
        // Legacy delta path (kept for safety; current code never sends this).
        this.book.decrement(orderId, qty)
        const after = this.book.get(orderId)
        if (after) after.version = version
      }
      this.emit('reduce', { orderId, qty, version })
      return
    }
    if (op === 'remove') {
      if (!current || current.version >= version) return
      this.book.remove(orderId)
      this.emit('remove', { orderId, version })
    }
  }

  _handleTryFill (payload) {
    const { makerOrderId, takerOrderId, takerNodeId, price, qty } = payload
    const maker = this.myOrders.get(makerOrderId)
    if (!maker) return { rejected: true, reason: 'gone' }

    const takerSide = maker.side === 'buy' ? 'sell' : 'buy'
    if (!crosses(takerSide, price, maker.price)) {
      return { rejected: true, reason: 'price-no-cross' }
    }

    const fillQty = Math.min(qty, maker.remaining)
    if (fillQty <= 0) return { rejected: true, reason: 'no-qty' }

    // ATOMIC BLOCK - no awaits between read and decrement
    maker.version += 1
    const newRemaining = maker.remaining - fillQty
    this.book.decrement(makerOrderId, fillQty)
    if (newRemaining <= 0) this.myOrders.delete(makerOrderId)

    if (this.wal) {
      this.wal.append(newRemaining > 0
        ? { op: 'reduce', orderId: makerOrderId, remaining: newRemaining, version: maker.version }
        : { op: 'remove', orderId: makerOrderId, version: maker.version })
    }
    const update = newRemaining > 0
      ? { type: 'applyUpdate', op: 'reduce', orderId: makerOrderId, qty: fillQty, remaining: newRemaining, version: maker.version }
      : { type: 'applyUpdate', op: 'remove', orderId: makerOrderId, version: maker.version }

    this.emit('trade', {
      role: 'maker',
      makerOrderId, takerOrderId, takerNodeId,
      makerNodeId: this.nodeId,
      price: maker.price,
      qty: fillQty
    })

    Promise.resolve(this.transport.broadcast('orderbook', update)).catch(() => {})

    return { filled: fillQty, remainingOnMaker: Math.max(0, newRemaining), version: maker.version }
  }

  async submitOrder ({ side, price, qty }) {
    if (!['buy', 'sell'].includes(side)) throw new Error('bad-side')
    if (!Number.isFinite(price) || price <= 0) throw new Error('bad-price')
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('bad-qty')

    const taker = {
      id: randomUUID(),
      ownerNodeId: this.nodeId,
      side, price, qty,
      remaining: qty,
      ts: Date.now(),
      version: 1
    }

    const fills = []

    while (taker.remaining > 0) {
      const candidates = findCandidates(taker, this.book)
      if (candidates.length === 0) break
      const c = candidates[0]

      if (c.ownerNodeId === this.nodeId) {
        const myMaker = this.myOrders.get(c.makerOrderId)
        if (!myMaker) {
          this.book.remove(c.makerOrderId)
          continue
        }
        const fillQty = Math.min(taker.remaining, myMaker.remaining)
        myMaker.version += 1
        const newRemaining = myMaker.remaining - fillQty
        this.book.decrement(c.makerOrderId, fillQty)
        if (newRemaining <= 0) this.myOrders.delete(c.makerOrderId)
        taker.remaining -= fillQty

        if (this.wal) {
          this.wal.append(newRemaining > 0
            ? { op: 'reduce', orderId: c.makerOrderId, remaining: newRemaining, version: myMaker.version }
            : { op: 'remove', orderId: c.makerOrderId, version: myMaker.version })
        }
        const update = newRemaining > 0
          ? { type: 'applyUpdate', op: 'reduce', orderId: c.makerOrderId, qty: fillQty, remaining: newRemaining, version: myMaker.version }
          : { type: 'applyUpdate', op: 'remove', orderId: c.makerOrderId, version: myMaker.version }

        fills.push({ makerOrderId: c.makerOrderId, qty: fillQty, price: c.price, self: true })
        this.emit('trade', {
          role: 'self',
          makerOrderId: c.makerOrderId, takerOrderId: taker.id,
          takerNodeId: this.nodeId, makerNodeId: this.nodeId,
          price: c.price, qty: fillQty
        })
        Promise.resolve(this.transport.broadcast('orderbook', update)).catch(() => {})
        continue
      }

      // Remote match
      let resp
      try {
        resp = await this.transport.request(
          'orderbook.node.' + c.ownerNodeId,
          {
            type: 'tryFill',
            makerOrderId: c.makerOrderId,
            takerOrderId: taker.id,
            takerNodeId: this.nodeId,
            price: c.price,
            qty: c.qty
          },
          { timeout: 1500 }
        )
      } catch (_) {
        // Owner unreachable - drop from local replica and try next
        this.book.remove(c.makerOrderId)
        continue
      }

      if (resp && resp.filled > 0) {
        taker.remaining -= resp.filled
        if (resp.remainingOnMaker === 0) {
          this.book.remove(c.makerOrderId)
        } else {
          const cur = this.book.get(c.makerOrderId)
          if (cur) {
            const delta = cur.remaining - resp.remainingOnMaker
            if (delta > 0) this.book.decrement(c.makerOrderId, delta)
            // Guard against version regression if a stale broadcast already advanced us past resp.version.
            if (cur.version < resp.version) cur.version = resp.version
          }
        }
        fills.push({
          makerOrderId: c.makerOrderId,
          qty: resp.filled,
          price: c.price,
          ownerNodeId: c.ownerNodeId,
          self: false
        })
        this.emit('trade', {
          role: 'taker',
          makerOrderId: c.makerOrderId, takerOrderId: taker.id,
          takerNodeId: this.nodeId, makerNodeId: c.ownerNodeId,
          price: c.price, qty: resp.filled
        })
      } else {
        // Rejection - drop from replica and try next
        this.book.remove(c.makerOrderId)
      }
    }

    let restingRemainder = 0
    if (taker.remaining > 0) {
      this.myOrders.set(taker.id, taker)
      this.book.add(taker)
      restingRemainder = taker.remaining
      if (this.wal) this.wal.append({ op: 'add', order: { ...taker } })
      const update = { type: 'applyUpdate', op: 'add', order: { ...taker }, version: taker.version }
      Promise.resolve(this.transport.broadcast('orderbook', update)).catch(() => {})
    }

    return { orderId: taker.id, fills, restingRemainder }
  }

  cancelOrder (orderId) {
    const o = this.myOrders.get(orderId)
    if (!o) throw new Error('not-your-order')
    o.version += 1
    this.myOrders.delete(orderId)
    this.book.remove(orderId)
    if (this.wal) this.wal.append({ op: 'remove', orderId, version: o.version })
    const update = { type: 'applyUpdate', op: 'remove', orderId, version: o.version }
    Promise.resolve(this.transport.broadcast('orderbook', update)).catch(() => {})
    this.emit('remove', { orderId, version: o.version })
    return { orderId, cancelled: true }
  }
}

module.exports = { Node }
