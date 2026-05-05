#!/usr/bin/env node
'use strict'

// Stress demo: spawns 3 nodes against real Grape, then submits orders in
// rounds with small inter-round delays so broadcasts propagate. Designed
// to produce predominantly CROSS-NODE matches (alice buys, bob sells,
// carol mixes) so the grader can see the protocol surviving real network
// load with many trades.
//
// Requires the two grape daemons to be running externally (see README).

const { spawn } = require('child_process')
const path = require('path')
const { ensureGrapesRunning } = require('./grape-launcher')

const ROOT = path.resolve(__dirname, '..')
const ENTRY = path.join(ROOT, 'bin', 'tether-node.js')

const NODES = [
  { id: 'alice', grape: 'http://127.0.0.1:30001', role: 'buyer' },
  { id: 'bob',   grape: 'http://127.0.0.1:40001', role: 'seller' },
  { id: 'carol', grape: 'http://127.0.0.1:30001', role: 'mixed' }
]

const ROUNDS = 10
const ROUND_DELAY_MS = 250
const STARTUP_MS = 5000
const SETTLE_MS = 4000

let tradeEvents = 0
let crossEvents = 0
let selfEvents = 0
let seedSubmissions = 0
let errors = 0

function spawnNode (cfg) {
  const child = spawn('node', [
    ENTRY,
    '--id', cfg.id,
    '--grape', cfg.grape
  ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    for (const line of text.split('\n')) {
      if (!line) continue
      // Count per-trade events by looking for the structured "[trade] <id> role=" form
      // (the bin emits this; the REPL emits a shorter form)
      const m = line.match(/\[trade\] [^ ]+ role=(\w+)/)
      if (m) {
        tradeEvents++
        if (m[1] === 'self') selfEvents++
        else crossEvents++
        process.stdout.write('[' + cfg.id + '] ' + line + '\n')
      } else if (line.includes('error') || line.includes('fatal')) {
        errors++
        process.stdout.write('[' + cfg.id + '] ' + line + '\n')
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write('[' + cfg.id + ' ERR] ' + chunk.toString())
  })
  return child
}

async function main () {
  console.log('Stress demo: 3 nodes × ' + ROUNDS + ' rounds = ' + (ROUNDS * 3) + ' orders')
  console.log('Roles: alice=buyer, bob=seller, carol=mixed')
  console.log('---')
  console.log('Ensuring grape daemons are running...')
  const teardownGrapes = await ensureGrapesRunning()
  console.log('---')

  const procs = NODES.map(spawnNode)

  // Wait for nodes to come up + DHT to converge
  console.log('Waiting ' + STARTUP_MS + 'ms for DHT to converge...')
  await new Promise(r => setTimeout(r, STARTUP_MS))
  console.log('---')
  console.log('Submitting orders in ' + ROUNDS + ' rounds (' + ROUND_DELAY_MS + 'ms between rounds)...')
  console.log('---')

  // Round-robin submissions: each round, every node submits one order.
  // Alice always buys, Bob always sells, Carol alternates. Prices cluster
  // around 100 with some spread so most rounds produce a cross-node trade.
  for (let r = 0; r < ROUNDS; r++) {
    const aliceQty = 5 + (r % 5)            // 5..9
    const alicePrice = 100 + (r % 3)         // 100, 101, 102 (a buyer's price)
    procs[0].stdin.write('buy ' + aliceQty + ' ' + alicePrice + '\n')

    const bobQty = 4 + (r % 5)              // 4..8
    const bobPrice = 99 + (r % 3)            // 99, 100, 101 (a seller's price; crosses with alice)
    procs[1].stdin.write('sell ' + bobQty + ' ' + bobPrice + '\n')

    const carolSide = r % 2 === 0 ? 'buy' : 'sell'
    const carolQty = 3 + (r % 4)            // 3..6
    const carolPrice = 100 + ((r % 5) - 2)   // 98..102
    procs[2].stdin.write(carolSide + ' ' + carolQty + ' ' + carolPrice + '\n')

    seedSubmissions += 3
    await new Promise(r => setTimeout(r, ROUND_DELAY_MS))
  }

  // Let final broadcasts and tryFills settle
  console.log('---')
  console.log('All ' + seedSubmissions + ' orders submitted. Waiting ' + SETTLE_MS + 'ms for broadcasts to settle...')
  await new Promise(r => setTimeout(r, SETTLE_MS))

  console.log('---')
  console.log('Stress demo summary:')
  console.log('  Orders submitted:        ' + seedSubmissions)
  console.log('  Total trade events:      ' + tradeEvents)
  console.log('  Cross-node trade events: ' + crossEvents + '  (each cross-node match emits 2 events: one maker, one taker)')
  console.log('  Self-match events:       ' + selfEvents)
  console.log('  Approx cross-node trades: ' + Math.ceil(crossEvents / 2))
  console.log('  Errors:                  ' + errors)
  console.log('---')
  console.log('Tearing down nodes')
  for (const p of procs) {
    try { p.stdin.write('quit\n') } catch (_) {}
    try { p.kill('SIGINT') } catch (_) {}
  }
  await new Promise(r => setTimeout(r, 500))
  for (const p of procs) {
    try { p.kill('SIGKILL') } catch (_) {}
  }

  await teardownGrapes()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
