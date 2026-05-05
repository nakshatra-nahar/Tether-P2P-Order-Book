'use strict'

const readline = require('readline')

const HELP = `Commands:
  buy <qty> <price>     submit buy order
  sell <qty> <price>    submit sell order
  cancel <orderId>      cancel one of your orders
  book                  print current orderbook (top of each side)
  mine                  print your own orders
  help                  show this help
  quit                  exit
`

function startRepl (node, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output, prompt: '> ' })

  const print = (s) => output.write(s + '\n')

  node.on('trade', (t) => {
    print(`[trade] ${t.role}  ${t.qty} @ ${t.price}  maker=${t.makerNodeId} taker=${t.takerNodeId}`)
  })

  print(`Tether node ready. nodeId=${node.nodeId}. Type 'help' for commands.`)
  rl.prompt()

  rl.on('line', async (raw) => {
    const line = raw.trim()
    if (!line) return rl.prompt()
    const [cmd, ...rest] = line.split(/\s+/)

    try {
      switch (cmd) {
        case 'buy':
        case 'sell': {
          const qty = Number(rest[0])
          const price = Number(rest[1])
          const r = await node.submitOrder({ side: cmd, qty, price })
          print(`order ${r.orderId}  fills=${r.fills.length}  resting=${r.restingRemainder}`)
          for (const f of r.fills) {
            print(`  filled ${f.qty} @ ${f.price} (maker ${f.makerOrderId}${f.self ? ' [self]' : ''})`)
          }
          break
        }
        case 'cancel': {
          const id = rest[0]
          if (!id) { print('usage: cancel <orderId>'); break }
          const r = node.cancelOrder(id)
          print(`cancelled ${r.orderId}`)
          break
        }
        case 'book': {
          const bestBid = node.book.peekBest('buy')
          const bestAsk = node.book.peekBest('sell')
          print(`bids: ${node.book.bids.length}  best=${bestBid ? `${bestBid.remaining}@${bestBid.price}` : '-'}`)
          print(`asks: ${node.book.asks.length}  best=${bestAsk ? `${bestAsk.remaining}@${bestAsk.price}` : '-'}`)
          break
        }
        case 'mine': {
          if (node.myOrders.size === 0) { print('(no orders)'); break }
          for (const o of node.myOrders.values()) {
            print(`  ${o.id}  ${o.side} ${o.remaining}/${o.qty} @ ${o.price}`)
          }
          break
        }
        case 'help':
          print(HELP)
          break
        case 'quit':
        case 'exit':
          rl.close()
          return
        default:
          print(`unknown command: ${cmd}. Type 'help'.`)
      }
    } catch (e) {
      print(`error: ${e.message}`)
    }
    rl.prompt()
  })

  rl.on('close', async () => {
    await node.stop()
    process.exit(0)
  })

  return rl
}

module.exports = { startRepl }
