#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { Transport } = require('../src/transport')
const { Node } = require('../src/node')
const { startRepl } = require('../src/repl')

function parseArgs (argv) {
  const args = { grape: 'http://127.0.0.1:30001', id: null, seed: null, noRepl: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--grape') args.grape = argv[++i]
    else if (a === '--id') args.id = argv[++i]
    else if (a === '--seed') args.seed = argv[++i]
    else if (a === '--no-repl') args.noRepl = true
  }
  return args
}

async function main () {
  const args = parseArgs(process.argv)
  const transport = new Transport({ grape: args.grape })
  transport.start()

  const node = new Node({ nodeId: args.id, transport })

  // Tag every trade with a stable label for log scraping in demo
  node.on('trade', (t) => {
    process.stdout.write(
      `[trade] ${node.nodeId} role=${t.role} qty=${t.qty} price=${t.price} ` +
      `maker=${t.makerNodeId} taker=${t.takerNodeId} ` +
      `makerOrder=${t.makerOrderId} takerOrder=${t.takerOrderId}\n`
    )
  })

  await node.start({})

  if (args.seed) {
    const seedPath = path.resolve(args.seed)
    const orders = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    for (const o of orders) {
      // Optional per-order delay (ms) lets seeds time-shift submissions
      if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs))
      try {
        const r = await node.submitOrder({ side: o.side, price: o.price, qty: o.qty })
        process.stdout.write(`[seed] submitted ${o.side} ${o.qty}@${o.price} → ${r.orderId}\n`)
      } catch (e) {
        process.stdout.write(`[seed-error] ${e.message}\n`)
      }
    }
  }

  if (args.noRepl) {
    // Stay alive until SIGINT
    process.stdin.resume()
    process.on('SIGINT', async () => { await node.stop(); process.exit(0) })
    process.on('SIGTERM', async () => { await node.stop(); process.exit(0) })
  } else {
    startRepl(node)
  }
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
