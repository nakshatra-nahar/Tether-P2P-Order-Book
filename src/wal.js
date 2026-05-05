'use strict'

const fs = require('fs')
const path = require('path')

// Append-only WAL: one JSON record per line. Records describe mutations to
// orders this node owns. Replay rebuilds the local-ownership state on
// restart before peer-snapshot merge fills in remote orders.
class Wal {
  constructor ({ dir, nodeId }) {
    if (!dir || !nodeId) throw new Error('Wal requires { dir, nodeId }')
    fs.mkdirSync(dir, { recursive: true })
    this.path = path.join(dir, nodeId + '.wal')
  }

  // Synchronous append — keeps WAL in lock-step with in-memory state.
  // Trade: blocks the event loop briefly per write. Acceptable for v1
  // since orders/sec is bounded; production would use an async batched writer.
  append (record) {
    fs.appendFileSync(this.path, JSON.stringify(record) + '\n')
  }

  // Replay every record through `handler(record)` in file order.
  // Missing file → empty replay (first start, no prior state).
  replay (handler) {
    if (!fs.existsSync(this.path)) return 0
    const data = fs.readFileSync(this.path, 'utf8')
    let count = 0
    for (const line of data.split('\n')) {
      if (!line) continue
      try {
        handler(JSON.parse(line))
        count += 1
      } catch (_) {
        // Skip malformed lines (truncated last write at crash, etc.)
      }
    }
    return count
  }
}

module.exports = { Wal }
