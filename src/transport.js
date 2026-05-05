'use strict'

const { PeerRPCServer, PeerRPCClient } = require('grenache-nodejs-http')
const Link = require('grenache-nodejs-link')

class Transport {
  constructor ({ grape }) {
    this.grape = grape
    this._announces = new Map()
    this._handler = null
  }

  start () {
    this.link = new Link({ grape: this.grape, requestTimeout: 10000 })
    this.link.start()

    this.server = new PeerRPCServer(this.link, { timeout: 300000 })
    this.server.init()

    this.client = new PeerRPCClient(this.link, {})
    this.client.init()

    // Pick a random ephemeral port. Grenache's TransportRPCServer stores the
    // port synchronously inside listen() and uses it for announce(); listen(0)
    // would announce port 0 because the OS-assigned port isn't read back.
    this.port = 1024 + Math.floor(Math.random() * 64000)
    this.service = this.server.transport('server')
    this.service.listen(this.port)

    this.service.on('request', (rid, key, payload, replyHandler) => {
      if (!this._handler) return replyHandler.reply(new Error('no-handler'), null)
      Promise.resolve()
        .then(() => this._handler(payload, key))
        .then(result => replyHandler.reply(null, result))
        .catch(err => replyHandler.reply(err, null))
    })
  }

  announce (name) {
    if (this._announces.has(name)) return
    const tick = () => {
      try { this.link.announce(name, this.port, {}) } catch (_) {}
    }
    tick()
    const h = setInterval(tick, 1000)
    this._announces.set(name, h)
  }

  unannounce (name) {
    const h = this._announces.get(name)
    if (h) {
      clearInterval(h)
      this._announces.delete(name)
    }
  }

  onRequest (handler) {
    this._handler = handler
  }

  request (serviceName, payload, opts = {}) {
    const timeout = opts.timeout || 5000
    return new Promise((resolve, reject) => {
      this.client.request(serviceName, payload, { timeout }, (err, data) => {
        if (err) return reject(err)
        resolve(data)
      })
    })
  }

  broadcast (serviceName, payload, opts = {}) {
    const timeout = opts.timeout || 2000
    return new Promise((resolve) => {
      this.client.map(serviceName, payload, { timeout }, (err, data) => {
        resolve({ err, data: data || [] })
      })
    })
  }

  stop () {
    for (const name of [...this._announces.keys()]) this.unannounce(name)
    try { if (this.service) this.service.stop() } catch (_) {}
    try { if (this.link) this.link.stop() } catch (_) {}
  }
}

module.exports = { Transport }
