'use strict'

class OrderBook {
  constructor () {
    this.bids = []
    this.asks = []
    this.index = new Map()
  }

  _cmp (side) {
    return side === 'buy'
      ? (a, b) => (b.price - a.price) || (a.ts - b.ts)
      : (a, b) => (a.price - b.price) || (a.ts - b.ts)
  }

  // Stores the order by reference; subsequent decrement(orderId, ...) mutates the caller's object.
  add (order) {
    if (this.index.has(order.id)) return false
    this.index.set(order.id, order)
    const arr = order.side === 'buy' ? this.bids : this.asks
    const cmp = this._cmp(order.side)
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cmp(arr[mid], order) <= 0) lo = mid + 1
      else hi = mid
    }
    arr.splice(lo, 0, order)
    return true
  }

  remove (orderId) {
    const order = this.index.get(orderId)
    if (!order) return null
    this.index.delete(orderId)
    const arr = order.side === 'buy' ? this.bids : this.asks
    const i = arr.indexOf(order)
    if (i >= 0) arr.splice(i, 1)
    return order
  }

  decrement (orderId, qty) {
    const order = this.index.get(orderId)
    if (!order) return null
    order.remaining -= qty
    if (order.remaining <= 0) return this.remove(orderId)
    return order
  }

  get (orderId) {
    return this.index.get(orderId) || null
  }

  peekBest (side) {
    const arr = side === 'buy' ? this.bids : this.asks
    return arr[0] || null
  }

  iterateOpposite (side) {
    return side === 'buy' ? this.asks : this.bids
  }

  snapshot () {
    return [...this.index.values()].map(o => ({ ...o }))
  }
}

module.exports = { OrderBook }
