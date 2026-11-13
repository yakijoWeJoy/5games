/*
 * Phone-to-phone sync.
 * Normal mode: WebRTC data channel via PeerJS (free public signaling server).
 * Test mode (?local=x): BroadcastChannel between tabs of the same browser.
 *
 * The host phone owns the game state; the guest sends actions and receives the full state.
 */
const PREFIX = 'daf-veiparon-5g-';
const params = new URLSearchParams(location.search);
export const LOCAL = params.has('local');

class Base {
  constructor(code, cb) {
    this.code = code;
    this.cb = cb;
    this.conn = null;
    this.linked = false;
    this.lastSeen = 0;
    this._st = null;
    this.timer = setInterval(() => this.tick(), 3000);
  }
  status(st) { if (this._st !== st) { this._st = st; this.cb.onStatus(st); } }
  setLinked(v) {
    this.linked = v;
    if (v) this.lastSeen = Date.now();
    this.status(v ? 'linked' : this.idleStatus());
  }
  idleStatus() { return 'waiting'; }
  sendRaw(d) {
    if (this.local) { this.bc.postMessage({ to: this.other, d }); return; }
    if (this.conn && this.conn.open) { try { this.conn.send(d); } catch { /* ignore */ } }
  }
  send(d) { this.sendRaw(d); }
  handle(d, conn) {
    if (!d || typeof d !== 'object') return;
    this.lastSeen = Date.now();
    if (d.t === 'ping') { this.sendRaw({ t: 'pong' }); return; }
    if (d.t === 'pong') return;
    this.onData(d, conn);
  }
  tick() {
    this.sendRaw({ t: 'ping' });
    if (this.linked && Date.now() - this.lastSeen > 11000) this.onLost();
  }
  onLost() { this.setLinked(false); }
  startLocal() {
    this.local = true;
    this.bc = new BroadcastChannel('dv-' + this.code);
    this.bc.onmessage = e => { if (e.data && e.data.to === this.me) this.handle(e.data.d, null); };
  }
  destroy() {
    clearInterval(this.timer);
    clearTimeout(this.rt);
    try { this.conn && this.conn.close(); } catch { /* ignore */ }
    try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
    try { this.bc && this.bc.close(); } catch { /* ignore */ }
  }
  noPeerLib() {
    if (typeof window.Peer === 'function') return false;
    this.status('offline');
    clearTimeout(this.rt);
    this.rt = setTimeout(() => this.start(), 4000);
    return true;
  }
}

export class HostNet extends Base {
  constructor(code, cb) { super(code, cb); this.me = 'host'; this.other = 'guest'; }
  start() {
    if (LOCAL) { this.startLocal(); this.status('waiting'); return; }
    if (this.noPeerLib()) return;
    this.makePeer();
  }
  makePeer() {
    const peer = this.peer = new window.Peer(PREFIX + this.code, { debug: 0 });
    peer.on('open', () => this.status(this.linked ? 'linked' : 'waiting'));
    peer.on('connection', conn => {
      conn.on('data', d => this.handle(d, conn));
      conn.on('close', () => { if (conn === this.conn) { this.conn = null; this.setLinked(false); } });
      conn.on('error', () => { /* ignore */ });
    });
    peer.on('disconnected', () => {
      if (peer.destroyed) return;
      clearTimeout(this.rt);
      this.rt = setTimeout(() => { try { if (!peer.destroyed && peer.disconnected) peer.reconnect(); } catch { /* ignore */ } }, 1500);
    });
    peer.on('error', err => {
      if (err.type === 'unavailable-id') {
        // our own old session is still registered on the server (page reload) – try again shortly
        this.status('offline');
        try { peer.destroy(); } catch { /* ignore */ }
        clearTimeout(this.rt);
        this.rt = setTimeout(() => this.makePeer(), 4000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type)) {
        this.status(this.linked ? 'linked' : 'offline');
        clearTimeout(this.rt);
        this.rt = setTimeout(() => this.wake(), 3000);
      }
    });
  }
  wake() {
    if (this.local) return;
    if (!this.peer || this.peer.destroyed) this.makePeer();
    else if (this.peer.disconnected) { try { this.peer.reconnect(); } catch { /* ignore */ } }
  }
  onData(d, conn) {
    if (d.t === 'hello') {
      if (this.cb.accept(d)) {
        if (!this.local && this.conn && this.conn !== conn) { try { this.conn.close(); } catch { /* ignore */ } }
        if (!this.local) this.conn = conn;
        this.setLinked(true);
        this.cb.onHello(d);
      } else if (this.local) {
        this.bc.postMessage({ to: 'guest', d: { t: 'full' } });
      } else {
        try { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 500); } catch { /* ignore */ }
      }
      return;
    }
    if (!this.local && conn !== this.conn) return;
    this.cb.onMessage(d);
  }
}

export class GuestNet extends Base {
  constructor(code, cb) { super(code, cb); this.me = 'guest'; this.other = 'host'; }
  idleStatus() { return this._st === 'no-host' ? 'no-host' : 'waiting'; }
  start() {
    if (LOCAL) { this.startLocal(); this.status('waiting'); this.sendRaw(this.cb.hello()); return; }
    if (this.noPeerLib()) return;
    this.makePeer();
  }
  tick() {
    super.tick();
    if (this.local && !this.linked) this.sendRaw(this.cb.hello());
  }
  makePeer() {
    const peer = this.peer = new window.Peer({ debug: 0 });
    peer.on('open', () => this.connect());
    peer.on('disconnected', () => { if (!peer.destroyed) this.retry(1500); });
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') { this.status('no-host'); this.retry(3500); }
      else if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected', 'webrtc'].includes(err.type)) {
        this.status('offline'); this.retry(3000);
      }
    });
  }
  connect() {
    if (!this.peer || this.peer.destroyed || this.peer.disconnected) { this.retry(1000); return; }
    if (this.conn) { try { this.conn.close(); } catch { /* ignore */ } }
    const conn = this.conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    conn.on('open', () => { this.lastSeen = Date.now(); this.sendRaw(this.cb.hello()); });
    conn.on('data', d => { if (conn === this.conn) this.handle(d); });
    conn.on('close', () => { if (conn === this.conn) { this.conn = null; this.setLinked(false); this.retry(2000); } });
    conn.on('error', () => { /* ignore */ });
    setTimeout(() => {
      if (conn === this.conn && !conn.open) { try { conn.close(); } catch { /* ignore */ } this.conn = null; this.retry(500); }
    }, 9000);
  }
  retry(ms) {
    if (this.local) return;
    clearTimeout(this.rt);
    this.rt = setTimeout(() => {
      if (!this.peer || this.peer.destroyed) this.makePeer();
      else if (this.peer.disconnected) { try { this.peer.reconnect(); } catch { /* ignore */ } this.rt = setTimeout(() => this.connect(), 1500); }
      else this.connect();
    }, ms);
  }
  wake() {
    if (this.local) { if (!this.linked) this.sendRaw(this.cb.hello()); return; }
    if (!this.linked || Date.now() - this.lastSeen > 6000) this.retry(0);
  }
  onLost() { super.onLost(); this.retry(0); }
  onData(d) {
    if (d.t === 'state' && !this.linked) this.setLinked(true);
    this.cb.onMessage(d);
  }
}
