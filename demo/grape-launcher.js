'use strict'

const { spawn } = require('child_process')
const net = require('net')

// Probe whether something is listening on a port. Resolves to true/false.
function isPortOpen (port, host = '127.0.0.1', timeoutMs = 200) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v) } }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

// Wait until a port is open or until timeout. Polls every 100ms.
async function waitForPort (port, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

// Spawn a grape, capturing output. Returns the child process.
function spawnGrape ({ dp, aph, bn }) {
  const child = spawn('grape', ['--dp', String(dp), '--aph', String(aph), '--bn', bn], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // Capture but don't print grape's own output (it's noisy and not useful in demo logs)
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  child.on('error', (e) => {
    if (e.code === 'ENOENT') {
      console.error('ERROR: `grape` command not found. Install with: npm i -g grenache-grape')
      process.exit(1)
    }
  })
  return child
}

// Public: ensure two grapes are running on the standard ports. If they
// already are (e.g. user started them manually), do nothing and return
// an empty cleanup function. Otherwise spawn them and return a function
// that tears them down.
//
// Standard ports per the challenge spec:
//   grape 1: dht 20001, http 30001, bootstrap 127.0.0.1:20002
//   grape 2: dht 20002, http 40001, bootstrap 127.0.0.1:20001
async function ensureGrapesRunning () {
  const need1 = !(await isPortOpen(30001))
  const need2 = !(await isPortOpen(40001))

  if (!need1 && !need2) {
    console.log('Grapes already running on 30001 and 40001 (will not touch).')
    return async () => {}
  }

  const spawned = []
  if (need1) {
    console.log('Starting grape 1 (dht 20001, http 30001)...')
    spawned.push(spawnGrape({ dp: 20001, aph: 30001, bn: '127.0.0.1:20002' }))
  }
  if (need2) {
    console.log('Starting grape 2 (dht 20002, http 40001)...')
    spawned.push(spawnGrape({ dp: 20002, aph: 40001, bn: '127.0.0.1:20001' }))
  }

  // Wait for both ports to come up
  const ok1 = await waitForPort(30001, 5000)
  const ok2 = await waitForPort(40001, 5000)
  if (!ok1 || !ok2) {
    console.error('Grapes did not become ready within 5s. Check that grenache-grape is installed.')
    for (const p of spawned) { try { p.kill('SIGKILL') } catch (_) {} }
    process.exit(1)
  }
  console.log('Grapes ready.')

  return async () => {
    for (const p of spawned) {
      try { p.kill('SIGINT') } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 300))
    for (const p of spawned) {
      try { p.kill('SIGKILL') } catch (_) {}
    }
  }
}

module.exports = { ensureGrapesRunning, isPortOpen, waitForPort }
