'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { OrderBook } = require('../src/orderbook')

function mk (over) {
  return Object.assign({
    id: 'o1', ownerNodeId: 'n1', side: 'buy',
    price: 100, qty: 5, remaining: 5, ts: 1, version: 1
  }, over)
}

test('add inserts and indexes', () => {
  const b = new OrderBook()
  assert.equal(b.add(mk({ id: 'a', side: 'buy', price: 100 })), true)
  assert.equal(b.get('a').id, 'a')
  assert.equal(b.bids.length, 1)
  assert.equal(b.asks.length, 0)
})

test('add is idempotent on duplicate id', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a' }))
  assert.equal(b.add(mk({ id: 'a' })), false)
  assert.equal(b.bids.length, 1)
})

test('bids sorted by price descending', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', price: 100, ts: 1 }))
  b.add(mk({ id: 'b', side: 'buy', price: 102, ts: 2 }))
  b.add(mk({ id: 'c', side: 'buy', price: 101, ts: 3 }))
  assert.deepEqual(b.bids.map(o => o.id), ['b', 'c', 'a'])
})

test('asks sorted by price ascending', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'sell', price: 100, ts: 1 }))
  b.add(mk({ id: 'b', side: 'sell', price: 102, ts: 2 }))
  b.add(mk({ id: 'c', side: 'sell', price: 101, ts: 3 }))
  assert.deepEqual(b.asks.map(o => o.id), ['a', 'c', 'b'])
})

test('FIFO within same price level', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', price: 100, ts: 5 }))
  b.add(mk({ id: 'b', side: 'buy', price: 100, ts: 1 }))
  b.add(mk({ id: 'c', side: 'buy', price: 100, ts: 3 }))
  assert.deepEqual(b.bids.map(o => o.id), ['b', 'c', 'a'])
})

test('peekBest returns top of side or null', () => {
  const b = new OrderBook()
  assert.equal(b.peekBest('buy'), null)
  b.add(mk({ id: 'a', side: 'buy', price: 99 }))
  b.add(mk({ id: 'b', side: 'buy', price: 100 }))
  assert.equal(b.peekBest('buy').id, 'b')
})

test('iterateOpposite returns asks for buy side, bids for sell side', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', price: 100 }))
  b.add(mk({ id: 'b', side: 'sell', price: 101 }))
  const fromBuy = [...b.iterateOpposite('buy')]
  const fromSell = [...b.iterateOpposite('sell')]
  assert.deepEqual(fromBuy.map(o => o.id), ['b'])
  assert.deepEqual(fromSell.map(o => o.id), ['a'])
})

test('decrement reduces remaining', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', price: 100, qty: 5, remaining: 5 }))
  b.decrement('a', 2)
  assert.equal(b.get('a').remaining, 3)
})

test('decrement to zero removes from book', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', remaining: 5 }))
  b.decrement('a', 5)
  assert.equal(b.get('a'), null)
  assert.equal(b.bids.length, 0)
})

test('decrement past zero removes', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', remaining: 3 }))
  b.decrement('a', 5)
  assert.equal(b.get('a'), null)
})

test('decrement on missing order returns null safely', () => {
  const b = new OrderBook()
  assert.equal(b.decrement('nope', 1), null)
})

test('remove returns the order or null', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a' }))
  assert.equal(b.remove('a').id, 'a')
  assert.equal(b.bids.length, 0)
  assert.equal(b.remove('a'), null)
})

test('snapshot returns plain copies', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy' }))
  b.add(mk({ id: 'b', side: 'sell' }))
  const snap = b.snapshot()
  assert.equal(snap.length, 2)
  snap[0].remaining = 999
  assert.notEqual(b.get(snap[0].id).remaining, 999)
})

test('removing a bid does not affect asks', () => {
  const b = new OrderBook()
  b.add(mk({ id: 'a', side: 'buy', price: 100 }))
  b.add(mk({ id: 'b', side: 'sell', price: 101 }))
  b.remove('a')
  assert.equal(b.bids.length, 0)
  assert.equal(b.asks.length, 1)
  assert.equal(b.get('b').id, 'b')
})
