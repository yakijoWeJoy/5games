/*
 * Phone-to-phone sync.
 *
 * Messages travel over several independent channels at the same time and are de-duplicated on arrival:
 *   - relay: public MQTT brokers over secure WebSocket (works on any network, including mobile data
 *            where two phones cannot reach each other directly)
 *   - direct: WebRTC data channel via PeerJS (when the network allows it)
 *   - test mode (?local=x): BroadcastChannel between tabs of the same browser
 *
 * The host phone owns the game state; the guest sends actions and receives the full state.
 */
import { log } from './log.js';

const params = new URLSearchParams(location.search);
export const LOCAL = params.has('local');
const TOPIC = 'dafveiparon5g/v2/';
const PEER_PREFIX = 'daf-veiparon-5g-';
const DEFAULT_BROKERS = [
  { name: 'emqx', host: 'broker.emqx.io', port: 8084, path: '/mqtt', ssl: true },
  { name: 'hivemq', host: 'broker.hivemq.com', port: 8884, path: '/mqtt', ssl: true },
  { name: 'mosquitto', host: 'test.mosquitto.org', port: 8081, path: '/', ssl: true },
  { name: 'eclipse', host: 'mqtt.eclipseprojects.io', port: 443, path: '/mqtt', ssl: true },
];
const brokers = () => window.__dvBrokers || DEFAULT_BROKERS; // tests point this at a local broker
const rid = (n = 8) => Math.random().toString(36).slice(2, 2 + n);

const BEAT = 3000;       // heartbeat
const LOST = 11000;      // no traffic for this long = the other phone is gone
const NO_HOST = 9000;    // guest: nobody answered for this long

/* ----------------------------- channels ----------------------------- */

class MqttChannel {
  constructor(cfg, topic, onMsg, onChange) {
    Object.assign(this, { cfg, topic, onMsg, onChange });
    this.name = 'relay:' + cfg.name;
    this.open = false; this.dead = false; this.fails = 0;
  }
  start() {
    if (this.dead) return;
    const P = window.Paho && (window.Paho.Client ? window.Paho : window.Paho.MQTT);
    if (!P) { log('ch-nolib', this.name); return; }
    clearTimeout(this.rt);
    const client = this.client = new P.Client(this.cfg.host, Number(this.cfg.port), this.cfg.path, 'dv' + rid(12));
    this.P = P;
    const t0 = Date.now();
    client.onMessageArrived = m => { if (client === this.client) { try { this.onMsg(m.payloadString, this.name); } catch { /* ignore */ } } };
    client.onConnectionLost = r => { if (client === this.client) this.down('lost ' + (r && r.errorCode)); };
    try {
      client.connect({
        useSSL: this.cfg.ssl !== false, timeout: 8, keepAliveInterval: 15, cleanSession: true, mqttVersion: 4,
        onSuccess: () => {
          if (client !== this.client || this.dead) return;
          client.subscribe(this.topic, {
            qos: 0,
            onSuccess: () => {
              if (client !== this.client) return;
              this.open = true; this.fails = 0;
              log('ch-open', `${this.name} ${Date.now() - t0}ms`);
              this.onChange(this);
            },
            onFailure: () => this.down('subscribe failed'),
          });
        },
        onFailure: e => { if (client === this.client) this.down('connect failed ' + (e && e.errorCode)); },
      });
    } catch (e) { this.down('throw ' + e.message); }
  }
  down(why) {
    const was = this.open;
    this.open = false;
    this.fails++;
    if (was || this.fails <= 2 || this.fails % 10 === 0) log('ch-down', `${this.name} ${why} #${this.fails}`);
    try { this.client && this.client.disconnect(); } catch { /* not connected */ }
    this.client = null;
    if (was) this.onChange(this);
    if (this.dead) return;
    clearTimeout(this.rt);
    this.rt = setTimeout(() => this.start(), Math.min(1500 * this.fails, 15000));
  }
  send(str) {
    if (!this.open || !this.client) return false;
    try {
      const m = new this.P.Message(str);
      m.destinationName = this.topic; m.qos = 0;
      this.client.send(m);
      return true;
    } catch { this.down('send failed'); return false; }
  }
  kick() {
    if (this.dead) return;
    let ok = false;
    try { ok = !!(this.client && this.client.isConnected()); } catch { ok = false; }
    if (!ok) { this.open = false; clearTimeout(this.rt); this.start(); }
  }
  stop() { this.dead = true; clearTimeout(this.rt); try { this.client && this.client.disconnect(); } catch { /* ignore */ } this.open = false; }
}

class PeerChannel {
  constructor(role, code, onMsg, onChange) {
    Object.assign(this, { role, code, onMsg, onChange });
    this.name = 'direct';
    this.conns = new Set();
    this.dead = false; this.fails = 0;
  }
  get open() { for (const c of this.conns) if (c.open) return true; return false; }
  start() {
    if (this.dead || typeof window.Peer !== 'function') return;
    clearTimeout(this.rt);
    let peer;
    try { peer = this.peer = this.role === 'host' ? new window.Peer(PEER_PREFIX + this.code, { debug: 0 }) : new window.Peer({ debug: 0 }); }
    catch (e) { log('direct-throw', e.message); return; }
    peer.on('open', () => { log('direct-signal', 'open'); if (this.role === 'guest') this.dial(); });
    peer.on('connection', conn => this.adopt(conn));
    peer.on('disconnected', () => { if (!peer.destroyed && !this.dead) this.later(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 2000); });
    peer.on('error', err => {
      this.fails++;
      if (this.fails <= 3 || this.fails % 10 === 0) log('direct-error', `${err.type} #${this.fails}`);
      if (err.type === 'unavailable-id') { try { peer.destroy(); } catch { /* ignore */ } if (this.onTaken && this.onTaken()) return; this.later(() => this.start(), 4000); }
      else if (err.type === 'peer-unavailable') this.later(() => this.dial(), 5000);
      else if (!this.dead) this.later(() => this.kick(), 5000);
    });
  }
  later(fn, ms) { clearTimeout(this.rt); this.rt = setTimeout(() => { if (!this.dead) fn(); }, ms); }
  adopt(conn) {
    const t0 = Date.now();
    const watchIce = () => {
      const pc = conn.peerConnection;
      if (!pc || pc.__dv) return;
      pc.__dv = true;
      pc.addEventListener('iceconnectionstatechange', () => {
        const st = pc.iceConnectionState;
        log('direct-ice', st);
        // PeerJS keeps a dead line marked as open – hang up ourselves so that we redial
        if (st === 'failed' || st === 'closed') this.drop(conn);
        else if (st === 'disconnected') setTimeout(() => { if (pc.iceConnectionState === 'disconnected') this.drop(conn); }, 4000);
      });
    };
    watchIce();
    conn.on('open', () => { watchIce(); this.conns.add(conn); this.fails = 0; log('ch-open', `direct ${Date.now() - t0}ms`); this.onChange(this); });
    conn.on('data', d => { if (typeof d === 'string') { try { this.onMsg(d, this.name); } catch { /* ignore */ } } });
    conn.on('close', () => { if (this.conns.delete(conn)) { log('ch-down', 'direct closed'); this.onChange(this); } if (this.role === 'guest' && conn === this.out) { this.out = null; this.later(() => this.dial(), 3000); } });
    conn.on('error', () => { /* handled by close / timeout */ });
  }
  drop(conn) {
    const had = this.conns.delete(conn);
    try { conn.close(); } catch { /* ignore */ }
    if (had) { log('ch-down', 'direct dropped'); this.onChange(this); }
    if (this.role === 'guest' && conn === this.out) { this.out = null; this.later(() => this.dial(), 1500); }
  }
  /** the other phone went silent: do not trust the line we have */
  reset() {
    if (this.dead) return;
    for (const c of [...this.conns]) this.drop(c);
    if (this.role === 'guest') { if (this.out) { const o = this.out; this.out = null; try { o.close(); } catch { /* ignore */ } } this.later(() => this.dial(), 500); }
  }
  /** the signalling server answers = this phone is online, even if no line is open yet */
  get signal() { return !!(this.peer && this.peer.open && !this.peer.disconnected && !this.peer.destroyed); }
  dial() {
    if (this.dead || this.role !== 'guest') return;
    const peer = this.peer;
    if (!peer || peer.destroyed) { this.start(); return; }
    if (peer.disconnected) { try { peer.reconnect(); } catch { /* ignore */ } this.later(() => this.dial(), 2500); return; }
    if (this.out && this.out.open) return;
    if (this.out) { const old = this.out; this.out = null; try { old.close(); } catch { /* ignore */ } }
    const conn = this.out = peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' });
    this.adopt(conn);
    setTimeout(() => {
      if (conn === this.out && !conn.open) {
        this.fails++;
        if (this.fails <= 3 || this.fails % 10 === 0) log('direct-timeout', `ice=${conn.peerConnection ? conn.peerConnection.iceConnectionState : '?'} #${this.fails}`);
        this.out = null; try { conn.close(); } catch { /* ignore */ }
        this.later(() => this.dial(), Math.min(4000 * this.fails, 30000));
      }
    }, 10000);
  }
  send(str) {
    let ok = false;
    for (const c of this.conns) if (c.open) { try { c.send(str); ok = true; } catch { /* ignore */ } }
    return ok;
  }
  kick() {
    if (this.dead) return;
    if (!this.peer || this.peer.destroyed) this.start();
    else if (this.peer.disconnected) { try { this.peer.reconnect(); } catch { /* ignore */ } }
    else if (this.role === 'guest') this.dial();
  }
  stop() { this.dead = true; clearTimeout(this.rt); try { this.peer && this.peer.destroy(); } catch { /* ignore */ } this.conns.clear(); }
}

class LocalChannel {
  constructor(code, onMsg, onChange) { Object.assign(this, { code, onMsg, onChange }); this.name = 'local'; this.open = false; }
  start() {
    this.bc = new BroadcastChannel('dv2-' + this.code);
    this.bc.onmessage = e => { if (typeof e.data === 'string') this.onMsg(e.data, this.name); };
    this.open = true;
    this.onChange(this);
  }
  send(str) { try { this.bc.postMessage(str); return true; } catch { return false; } }
  kick() { /* always up */ }
  stop() { this.open = false; try { this.bc.close(); } catch { /* ignore */ } }
}

/* ----------------------------- the link ----------------------------- */

/**
 * cb: onStatus(st), onMessage(d),
 *     host:  accept(hello) -> bool, onHello(hello), guestToken() -> token|null, onIdTaken() -> bool, isFresh() -> bool
 *     guest: hello() -> {t:'hello', token, name}
 * status: 'linked' | 'waiting' | 'no-host' | 'offline' | 'full'
 */
export class Link {
  constructor(role, code, cb) {
    Object.assign(this, { role, code, cb });
    this.id = rid(10);
    this.seen = new Map();
    this.linked = false; this.full = false; this.dead = false;
    this.lastSeen = 0; this.hostSeen = 0; this.t0 = Date.now(); this.tryingSince = Date.now();
    this.st = null;
    this.channels = [];
  }
  start() {
    const onMsg = (str, ch) => this.receive(str, ch);
    const onChange = () => { if (!this.dead) { this.greet(); this.refresh(); } };
    if (LOCAL) this.channels.push(new LocalChannel(this.code, onMsg, onChange));
    else {
      for (const b of brokers()) this.channels.push(new MqttChannel(b, TOPIC + this.code, onMsg, onChange));
      if (!window.__dvNoDirect) {
        const pc = new PeerChannel(this.role, this.code, onMsg, onChange);
        pc.onTaken = () => !!(this.role === 'host' && this.cb.isFresh && this.cb.isFresh() && this.cb.onIdTaken && this.cb.onIdTaken());
        this.channels.push(pc);
      }
    }
    log('net-start', { role: this.role, ch: this.channels.map(c => c.name).join(',') });
    this.status(this.compute());
    for (const c of this.channels) c.start();
    this.timer = setInterval(() => this.tick(), BEAT);
  }
  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    for (const c of this.channels) c.stop();
  }
  info() {
    return {
      status: this.st, channels: this.channels.map(c => ({ name: c.name, open: !!c.open })),
      lastSeen: this.lastSeen ? Math.round((Date.now() - this.lastSeen) / 1000) : null,
      hostSeen: this.hostSeen ? Math.round((Date.now() - this.hostSeen) / 1000) : null,
    };
  }
  anyOpen() { return this.channels.some(c => c.open); }
  compute() {
    if (this.full) return 'full';
    if (this.linked) return 'linked';
    if (!this.anyOpen() && !this.channels.some(c => c.signal)) return Date.now() - this.t0 < 6000 ? 'waiting' : 'offline';
    if (this.role === 'guest' && Date.now() - this.hostSeen > LOST && Date.now() - this.tryingSince > NO_HOST) return 'no-host';
    return 'waiting';
  }
  status(st) {
    if (this.st === st) return;
    log('status', `${this.st || '-'} > ${st} [${this.channels.filter(c => c.open).map(c => c.name).join(',')}]`, true);
    this.st = st;
    this.cb.onStatus(st);
  }
  refresh() { this.status(this.compute()); }
  setLinked(v) {
    if (this.linked !== v) { this.linked = v; if (!v) this.tryingSince = Date.now(); }
    if (v) this.lastSeen = Date.now();
    this.refresh();
  }

  /* ---- sending ---- */
  raw(d, to) {
    const env = { i: rid(10), r: this.role === 'host' ? 'h' : 'g', f: this.id, d };
    if (to) env.to = to;
    if (this.role === 'guest') env.k = this.token();
    const room = this.cb.roomId && this.cb.roomId(); // which evening this belongs to (two families may share a code)
    if (room) env.h = room;
    const str = JSON.stringify(env);
    let sent = 0;
    for (const c of this.channels) if (c.open && c.send(str)) sent++;
    return sent;
  }
  token() { if (!this._tok) this._tok = this.cb.hello().token; return this._tok; }
  /** app-level message to the other phone */
  send(d) {
    if (this.role === 'host') {
      const g = this.cb.guestToken();
      if (g) this.raw(d, g);
      else if (this.linked) { this.setLinked(false); this.greet(); }
    } else this.raw(d);
  }
  greet() {
    if (this.role === 'host') this.raw({ t: 'beat', g: this.cb.guestToken() || null });
    else if (!this.linked && !this.full) { this.raw(this.cb.hello()); }
  }
  tick() {
    if (this.dead) return;
    if (this.linked && Date.now() - this.lastSeen > LOST) {
      log('lost', `${Math.round((Date.now() - this.lastSeen) / 1000)}s silent`);
      this.setLinked(false);
      for (const c of this.channels) if (c.reset) c.reset();
    }
    if (this.role === 'host' && this.linked && !this.cb.guestToken()) this.setLinked(false); // the partner was removed
    if (this.role === 'host') this.raw({ t: 'beat', g: this.cb.guestToken() || null });
    else if (this.linked) this.raw({ t: 'ping' });
    else if (!this.full) this.raw(this.cb.hello());
    this.refresh();
  }
  wake() {
    if (this.dead) return;
    log('wake', this.st);
    if (this.full) { this.full = false; this.tryingSince = Date.now(); }
    for (const c of this.channels) c.kick();
    this.greet();
    this.refresh();
  }

  /* ---- receiving ---- */
  receive(str, ch) {
    if (this.dead) return;
    let e;
    try { e = JSON.parse(str); } catch { return; }
    if (!e || typeof e !== 'object' || !e.i || e.f === this.id || !e.d || typeof e.d !== 'object') return;
    if (this.seen.has(e.i)) return;
    this.seen.set(e.i, 1);
    if (this.seen.size > 600) { let n = 0; for (const k of this.seen.keys()) { this.seen.delete(k); if (++n > 200) break; } }
    const d = e.d;
    if (this.role === 'host') this.hostReceive(e, d, ch); else this.guestReceive(e, d, ch);
  }
  hostReceive(e, d) {
    if (e.r === 'h') {
      // another host is using this code right now
      if (this.cb.isFresh && this.cb.isFresh() && !this.conflict) { this.conflict = true; log('code-taken', this.code, true); this.cb.onIdTaken && this.cb.onIdTaken(); }
      return;
    }
    if (e.r !== 'g' || typeof e.k !== 'string' || !e.k) return;
    if (e.h && e.h !== this.cb.roomId()) return; // a guest of another page that happens to use the same code
    if (d.t === 'hello') {
      if (d.token !== e.k) return;
      if (this.cb.accept(d)) {
        const first = !this.linked;
        this.lastSeen = Date.now();
        this.linked = true;
        if (first) log('guest-in', null, true);
        this.cb.onHello(d);
        this.refresh();
      } else {
        this.raw({ t: 'full' }, e.k);
      }
      return;
    }
    if (e.k !== this.cb.guestToken()) return;
    this.lastSeen = Date.now();
    if (!this.linked) { log('guest-back'); this.setLinked(true); }
    if (d.t === 'ping') return;
    this.cb.onMessage(d);
  }
  guestReceive(e, d, ch) {
    if (e.r !== 'h') return;
    const mine = this.token();
    if (e.to && e.to !== mine) return;
    const room = this.cb.roomId && this.cb.roomId();
    if (room && e.h && e.h !== room) return; // another host using the same code
    this.hostSeen = Date.now();
    if (d.t === 'beat') {
      if (d.g === mine) this.lastSeen = Date.now();
      else if (this.linked) { log('replaced'); this.setLinked(false); this.greet(); } // the host no longer counts us in
      else this.refresh();
      return;
    }
    if (!e.to) return;
    if (d.t === 'full') {
      if (!this.full) { this.full = true; this.linked = false; log('full', null, true); this.refresh(); }
      return;
    }
    this.lastSeen = Date.now();
    if (d.t === 'state') {
      this.full = false;
      if (!this.linked) { log('linked-via', `${ch} after ${Date.now() - this.tryingSince}ms`, true); this.setLinked(true); }
    }
    this.cb.onMessage(d);
  }
}
