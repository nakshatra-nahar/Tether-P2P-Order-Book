#!/usr/bin/env node
'use strict'

// Crash-recovery demo: visibly demonstrates the WAL persistence feature.
// Spawns one node with --wal-dir, submits orders, kills it (SIGKILL),
// restarts a fresh process with the same --wal-dir + --id, and shows
// that the orders are recovered from the WAL.
//
// Auto-spawns grape daemons if they're not already running.

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { ensureGrapesRunning } = require('./grape-launcher')

const ROOT = path.resolve(__dirname, '..')
const ENTRY = path.join(ROOT, 'bin', 'tether-node.js')

function spawnNode (cfg) {
  const child = spawn('node', [
    ENTRY,
    '--id', cfg.id,
    '--grape', cfg.grape,
    '--wal-dir', cfg.walDir
  ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue
      process.stdout.write('  ' + line + '\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write('  [ERR] ' + chunk.toString())
  })
  return child
}

function delay (ms) { return new Promise(r => setTimeout(r, ms)) }

async function main () {
  const walDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-crash-demo-'))
  console.log('Crash-recovery demo')
  console.log('  WAL dir: ' + walDir)
  console.log('---')

  const teardownGrapes = await ensureGrapesRunning()
  console.log('---')

  // Phase 1: first incarnation
  console.log('Phase 1: starting node (id=alice) and submitting 3 orders')
  console.log('---')
  let alice = spawnNode({ id: 'alice', grape: 'http://127.0.0.1:30001', walDir })
  await delay(2500)  // let it announce + snapshot

  alice.stdin.write('buy 5 100\n')
  await delay(300)
  alice.stdin.write('sell 3 110\n')
  await delay(300)
  alice.stdin.write('buy 2 99\n')
  await delay(500)
  alice.stdin.write('mine\n')
  await delay(500)

  console.log('---')
  console.log('WAL contents on disk:')
  const walFile = path.join(walDir, 'alice.wal')
  if (fs.existsSync(walFile)) {
    const lines = fs.readFileSync(walFile, 'utf8').trim().split('\n')
    console.log('  ' + lines.length + ' records written')
    for (const ln of lines) console.log('  ' + ln)
  } else {
    console.log('  (no WAL file found — something is wrong)')
  }

  console.log('---')
  console.log('Phase 2: SIGKILL the node (simulating a crash)')
  alice.kill('SIGKILL')
  await delay(500)

  console.log('---')
  console.log('Phase 3: starting a fresh node with the same --id and --wal-dir')
  console.log('         (orders should be recovered from disk)')
  console.log('---')
  alice = spawnNode({ id: 'alice', grape: 'http://127.0.0.1:30001', walDir })
  await delay(2500)

  alice.stdin.write('mine\n')
  await delay(500)
  alice.stdin.write('book\n')
  await delay(500)

  console.log('---')
  console.log('Phase 4: tearing down')
  alice.stdin.write('quit\n')
  await delay(500)
  try { alice.kill('SIGKILL') } catch (_) {}

  await teardownGrapes()

  // Cleanup the temp WAL dir
  try { fs.rmSync(walDir, { recursive: true, force: true }) } catch (_) {}

  console.log('---')
  console.log('Crash-recovery demo complete. Phase 3 should have shown the same 3')
  console.log("orders as Phase 1's 'mine' output, recovered from disk after the kill.")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
