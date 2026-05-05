#!/usr/bin/env node
'use strict'

const { spawn } = require('child_process')
const path = require('path')
const { ensureGrapesRunning } = require('./grape-launcher')

const ROOT = path.resolve(__dirname, '..')
const ENTRY = path.join(ROOT, 'bin', 'tether-node.js')

const NODES = [
  { id: 'alice', seed: 'demo/seeds/alice.json', grape: 'http://127.0.0.1:30001' },
  { id: 'bob',   seed: 'demo/seeds/bob.json',   grape: 'http://127.0.0.1:40001' },
  { id: 'carol', seed: 'demo/seeds/carol.json', grape: 'http://127.0.0.1:30001' }
]

const RUN_FOR_MS = 14000

function spawnNode (cfg) {
  const child = spawn('node', [
    ENTRY,
    '--id', cfg.id,
    '--grape', cfg.grape,
    '--seed', cfg.seed,
    '--no-repl'
  ], { cwd: ROOT })

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue
      process.stdout.write(`[${cfg.id}] ${line}\n`)
    }
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${cfg.id} ERR] ${chunk.toString()}`)
  })
  child.on('exit', (code) => {
    process.stdout.write(`[${cfg.id}] exited (${code})\n`)
  })
  return child
}

async function main () {
  console.log('Demo: ensuring grape daemons are running...')
  const teardownGrapes = await ensureGrapesRunning()
  console.log('Demo: spawning 3 nodes')
  console.log('---')

  const procs = NODES.map(spawnNode)

  await new Promise(r => setTimeout(r, RUN_FOR_MS))

  console.log('---')
  console.log('Demo: tearing down nodes')
  for (const p of procs) {
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
