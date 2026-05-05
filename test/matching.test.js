'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { OrderBook } = require('../src/orderbook')
const { findCandidates, crosses } = require('../src/matching')

function mk (over) {
  return Object.assign({
    id: 'o', ownerNodeId: 'n1', side: 'buy',
    price: 100, qty: 5, remaining: 5, ts: 1, version: 1
  }, over)
}

test('crosses: buy taker crosses ask at lower or equal price', () => {
  assert.equal(crosses('buy', 100, 99), true)
  assert.equal(crosses('buy', 100, 100), true)
  assert.equal(crosses('buy', 100, 101), false)
})

test('crosses: sell taker crosses bid at higher or equal price', () => {
  assert.equal(crosses('sell', 100, 101), true)
  assert.equal(crosses('sell', 100, 100), true)
  assert.equal(crosses('sell', 100, 99), false)
})

test('empty book returns no candidates', () => {
  const b = new OrderBook()
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 5 })
  assert.deepEqual(findCandidates(taker, b), [])
})

test('buy taker fully filled by single ask', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'sell', price: 99, remaining: 10, ownerNodeId: 'm' }))
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 5 })
  const c = findCandidates(taker, b)
  assert.equal(c.length, 1)
  assert.equal(c[0].makerOrderId, 'a')
  assert.equal(c[0].qty, 5)
  assert.equal(c[0].price, 99)
  assert.equal(c[0].ownerNodeId, 'm')
})

test('buy taker walks multiple asks at increasing price', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'sell', price: 99, remaining: 3, ts: 1 }))
  b.add(mk({ id: 'b', side: 'sell', price: 100, remaining: 4, ts: 2 }))
  b.add(mk({ id: 'c', side: 'sell', price: 101, remaining: 5, ts: 3 }))
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 6 })
  const c = findCandidates(taker, b)
  assert.deepEqual(c.map(x => [x.makerOrderId, x.qty]), [['a', 3], ['b', 3]])
})

test('does not walk past non-crossing price', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'sell', price: 99, remaining: 3 }))
  b.add(mk({ id: 'b', side: 'sell', price: 105, remaining: 10 }))
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 10 })
  const c = findCandidates(taker, b)
  assert.deepEqual(c.map(x => x.makerOrderId), ['a'])
})

test('sell taker matches descending bids', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', price: 102, remaining: 3, ts: 1 }))
  b.add(mk({ id: 'b', side: 'buy', price: 101, remaining: 4, ts: 2 }))
  b.add(mk({ id: 'c', side: 'buy', price: 99, remaining: 5, ts: 3 }))
  const taker = mk({ id: 't', side: 'sell', price: 101, remaining: 5 })
  const c = findCandidates(taker, b)
  assert.deepEqual(c.map(x => [x.makerOrderId, x.qty]), [['a', 3], ['b', 2]])
})

test('partial fill — taker remainder reflected in returned qty', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'sell', price: 99, remaining: 2 }))
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 5 })
  const c = findCandidates(taker, b)
  assert.equal(c.length, 1)
  assert.equal(c[0].qty, 2)
})

test('within a single price level, earlier ts is consumed first', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'late',  side: 'sell', price: 99, remaining: 5, ts: 2 }))
  b.add(mk({ id: 'early', side: 'sell', price: 99, remaining: 5, ts: 1 }))
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 3 })
  const c = findCandidates(taker, b)
  assert.equal(c.length, 1)
  assert.equal(c[0].makerOrderId, 'early')
  assert.equal(c[0].qty, 3)
})

test('self-trade is not filtered out at the matcher level', () => {
  // Matching is purely candidate-finding; the Node orchestrator decides what to do
  // with same-owner candidates. The matcher MUST surface them so callers can route.
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'sell', price: 99, remaining: 5, ownerNodeId: 'SELF' }))
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 3, ownerNodeId: 'SELF' })
  const c = findCandidates(taker, b)
  assert.equal(c.length, 1)
  assert.equal(c[0].ownerNodeId, 'SELF')
})

test('candidate object has exactly four keys', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'sell', price: 99, remaining: 5, ownerNodeId: 'm' }))
  const taker = mk({ id: 't', side: 'buy', price: 100, remaining: 3 })
  const c = findCandidates(taker, b)
  assert.deepEqual(c, [
    { makerOrderId: 'a', ownerNodeId: 'm', price: 99, qty: 3 }
  ])
})
