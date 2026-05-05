'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { Wal } = require('../src/wal')

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tether-wal-'))
}

test('replay on missing file returns 0 records', () => {
  const dir = tmpDir()
  const wal = new Wal({ dir, nodeId: 'never-written' })
  let count = 0
  const replayed = wal.replay(() => { count++ })
  assert.equal(replayed, 0)
  assert.equal(count, 0)
})

test('append then replay yields records in order', () => {
  const dir = tmpDir()
  const wal = new Wal({ dir, nodeId: 'A' })
  wal.append({ op: 'add', order: { id: 'o1', remaining: 5 } })
  wal.append({ op: 'reduce', orderId: 'o1', remaining: 3, version: 2 })
  wal.append({ op: 'remove', orderId: 'o1', version: 3 })

  const records = []
  wal.replay((r) => records.push(r))
  assert.equal(records.length, 3)
  assert.equal(records[0].op, 'add')
  assert.equal(records[1].op, 'reduce')
  assert.equal(records[2].op, 'remove')
})

test('replay survives a malformed trailing line (simulated crash)', () => {
  const dir = tmpDir()
  const wal = new Wal({ dir, nodeId: 'A' })
  wal.append({ op: 'add', order: { id: 'o1' } })
  // Manually write a partial line as if the process crashed mid-write
  fs.appendFileSync(wal.path, '{"op":"add","ord')

  const records = []
  const count = wal.replay((r) => records.push(r))
  assert.equal(count, 1)        // only the well-formed record
  assert.equal(records[0].op, 'add')
})

test('two Wal instances with different nodeIds are isolated', () => {
  const dir = tmpDir()
  const a = new Wal({ dir, nodeId: 'A' })
  const b = new Wal({ dir, nodeId: 'B' })
  a.append({ op: 'add', order: { id: 'oA' } })
  b.append({ op: 'add', order: { id: 'oB' } })

  const aRec = []
  const bRec = []
  a.replay((r) => aRec.push(r))
  b.replay((r) => bRec.push(r))
  assert.equal(aRec.length, 1)
  assert.equal(bRec.length, 1)
  assert.equal(aRec[0].order.id, 'oA')
  assert.equal(bRec[0].order.id, 'oB')
})

test('constructor throws without dir or nodeId', () => {
  assert.throws(() => new Wal({}), /requires/)
  assert.throws(() => new Wal({ dir: '/tmp' }), /requires/)
  assert.throws(() => new Wal({ nodeId: 'A' }), /requires/)
})
