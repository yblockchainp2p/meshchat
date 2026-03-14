// ═══════════════════════════════════════════════════════════════
// MeshChat v9 — Crypto Identity + E2E DM + IndexedDB Persistence
// All code and comments in English
// ═══════════════════════════════════════════════════════════════

const BOOTSTRAP = 'wss://meshchat-bootstrap.onrender.com';
const CFG = {
  K: 20, ALPHA: 3, MAX_PEERS: 20, FANOUT: 6, TTL: 10,
  MSG_CACHE: 2000, HISTORY: 100, HB: 15000, TIMEOUT: 45000, REFRESH: 60000,
  DB_NAME: 'meshchat', DB_VER: 4,
  // ActionLog / Block config
  EPOCH_MS: 30000,      // 30 second epochs
  EPOCH_DELAY: 15000,   // 15 second delay before block closes
  MAX_LOG: 5000,        // max actions in memory
  PRUNE_AGE: 48 * 3600 * 1000, // 48h prune
};

// ═══════════════════════════════════════
// 1. CRYPTO IDENTITY — ECDSA + ECDH
// ═══════════════════════════════════════
class CryptoId {
  constructor() {
    this.signKeys = null;   // ECDSA {publicKey, privateKey}
    this.dhKeys = null;     // ECDH {publicKey, privateKey}
    this.pubKeyHex = '';    // Public key as hex for node ID
    this.shortId = '';      // First 4 hex chars for display
  }

  // Generate or load keypairs
  async init() {
    const stored = await DB.getKey('identity');
    if (stored) {
      this.signKeys = {
        publicKey: await crypto.subtle.importKey('jwk', stored.signPub, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
        privateKey: await crypto.subtle.importKey('jwk', stored.signPriv, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
      };
      this.dhKeys = {
        publicKey: await crypto.subtle.importKey('jwk', stored.dhPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
        privateKey: await crypto.subtle.importKey('jwk', stored.dhPriv, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
      };
    } else {
      this.signKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      this.dhKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      await this.save();
    }
    // Export public key as hex for node ID
    const raw = await crypto.subtle.exportKey('raw', this.signKeys.publicKey);
    this.pubKeyHex = [...new Uint8Array(raw)].map(b => b.toString(16).padStart(2, '0')).join('');
    this.shortId = this.pubKeyHex.slice(0, 8);
  }

  async save() {
    const signPub = await crypto.subtle.exportKey('jwk', this.signKeys.publicKey);
    const signPriv = await crypto.subtle.exportKey('jwk', this.signKeys.privateKey);
    const dhPub = await crypto.subtle.exportKey('jwk', this.dhKeys.publicKey);
    const dhPriv = await crypto.subtle.exportKey('jwk', this.dhKeys.privateKey);
    await DB.setKey('identity', { signPub, signPriv, dhPub, dhPriv });
  }

  // Export public keys for sharing with peers
  async exportPublic() {
    return {
      sign: await crypto.subtle.exportKey('jwk', this.signKeys.publicKey),
      dh: await crypto.subtle.exportKey('jwk', this.dhKeys.publicKey),
    };
  }

  // Sign a message
  async sign(data) {
    const enc = new TextEncoder().encode(JSON.stringify(data));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.signKeys.privateKey, enc);
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  // Verify a signature from a peer's public key (JWK)
  async verify(data, sigB64, peerSignJwk) {
    try {
      const key = await crypto.subtle.importKey('jwk', peerSignJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
      const enc = new TextEncoder().encode(JSON.stringify(data));
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, enc);
    } catch (e) {
      console.error('Verify failed:', e);
      return false;
    }
  }

  // Derive shared secret for E2E DM (ECDH + AES-GCM)
  async deriveShared(peerDhJwk) {
    const peerKey = await crypto.subtle.importKey('jwk', peerDhJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, this.dhKeys.privateKey, 256);
    return await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  // Encrypt for DM
  async encrypt(text, sharedKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder().encode(text);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, enc);
    return {
      iv: btoa(String.fromCharCode(...iv)),
      ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
    };
  }

  // Decrypt DM
  async decrypt(ivB64, ctB64, sharedKey) {
    try {
      const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
      const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ct);
      return new TextDecoder().decode(pt);
    } catch (e) {
      return '[decryption failed]';
    }
  }

  // Generate node ID from public key (SHA-1 hash)
  async nodeId() {
    const raw = await crypto.subtle.exportKey('raw', this.signKeys.publicKey);
    const hash = await crypto.subtle.digest('SHA-1', raw);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

// ═══════════════════════════════════════
// 2. INDEXEDDB PERSISTENCE
// ═══════════════════════════════════════
const DB = {
  db: null,

  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CFG.DB_NAME, CFG.DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('messages')) {
          const ms = db.createObjectStore('messages', { keyPath: 'msgId' });
          ms.createIndex('channel', 'channel', { unique: false });
          ms.createIndex('ts', 'ts', { unique: false });
        }
        if (!db.objectStoreNames.contains('channels')) db.createObjectStore('channels', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('peers')) db.createObjectStore('peers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fileCache')) db.createObjectStore('fileCache', { keyPath: 'id' });
        // v4: ActionLog stores
        if (!db.objectStoreNames.contains('actions')) {
          const as = db.createObjectStore('actions', { keyPath: 'id' });
          as.createIndex('epoch', 'epoch', { unique: false });
          as.createIndex('lamport', 'lamport', { unique: false });
          as.createIndex('type', 'type', { unique: false });
          as.createIndex('channel', 'channel', { unique: false });
        }
        if (!db.objectStoreNames.contains('blocks')) {
          const bs = db.createObjectStore('blocks', { keyPath: 'key' });
          bs.createIndex('epoch', 'epoch', { unique: false });
        }
      };
      req.onsuccess = (e) => { DB.db = e.target.result; resolve(); };
      req.onerror = (e) => { console.error('DB error:', e); resolve(); }; // Don't block on DB failure
    });
  },

  async getKey(key) {
    if (!DB.db) return null;
    return new Promise(r => {
      const tx = DB.db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => r(req.result || null);
      req.onerror = () => r(null);
    });
  },

  async setKey(key, val) {
    if (!DB.db) return;
    return new Promise(r => {
      const tx = DB.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => r();
      tx.onerror = () => r();
    });
  },

  async saveMsg(msg) {
    if (!DB.db) return;
    return new Promise(r => {
      const tx = DB.db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put(msg);
      tx.oncomplete = () => r();
      tx.onerror = () => r();
    });
  },

  async deleteMsg(msgId) {
    if (!DB.db || !msgId) return;
    return new Promise(r => {
      const tx = DB.db.transaction('messages', 'readwrite');
      tx.objectStore('messages').delete(msgId);
      tx.oncomplete = () => r();
      tx.onerror = () => r();
    });
  },

  async getMsgs(channel, limit = CFG.HISTORY) {
    if (!DB.db) return [];
    return new Promise(r => {
      const tx = DB.db.transaction('messages', 'readonly');
      const idx = tx.objectStore('messages').index('channel');
      const msgs = [];
      const req = idx.openCursor(IDBKeyRange.only(channel), 'prev');
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && msgs.length < limit) { msgs.unshift(cur.value); cur.continue(); }
        else r(msgs);
      };
      req.onerror = () => r([]);
    });
  },

  async getAllMsgs(limit = 500) {
    if (!DB.db) return [];
    return new Promise(r => {
      const tx = DB.db.transaction('messages', 'readonly');
      const idx = tx.objectStore('messages').index('ts');
      const msgs = [];
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && msgs.length < limit) { msgs.unshift(cur.value); cur.continue(); }
        else r(msgs);
      };
      req.onerror = () => r([]);
    });
  },

  async getChannels() {
    if (!DB.db) return [];
    return new Promise(r => {
      const tx = DB.db.transaction('channels', 'readonly');
      const req = tx.objectStore('channels').getAll();
      req.onsuccess = () => r(req.result || []);
      req.onerror = () => r([]);
    });
  },

  async saveChannel(ch) {
    if (!DB.db) return;
    return new Promise(r => {
      const tx = DB.db.transaction('channels', 'readwrite');
      tx.objectStore('channels').put(ch);
      tx.oncomplete = () => r();
      tx.onerror = () => r();
    });
  },

  async savePeer(peer) {
    if (!DB.db) return;
    return new Promise(r => {
      const tx = DB.db.transaction('peers', 'readwrite');
      tx.objectStore('peers').put(peer);
      tx.oncomplete = () => r();
      tx.onerror = () => r();
    });
  },

  async getPeers() {
    if (!DB.db) return [];
    return new Promise(r => {
      const tx = DB.db.transaction('peers', 'readonly');
      const req = tx.objectStore('peers').getAll();
      req.onsuccess = () => r(req.result || []);
      req.onerror = () => r([]);
    });
  },

  // Delete all data — full reset
  async clearAll() {
    if (!DB.db) return;
    const stores = ['kv', 'messages', 'channels', 'peers', 'actions', 'blocks'];
    for (const name of stores) {
      try {
        const tx = DB.db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
      } catch (_) {}
    }
  },

  // ── ActionLog DB methods ──
  async saveAction(action) {
    if (!DB.db) return;
    return new Promise(r => {
      try {
        const tx = DB.db.transaction('actions', 'readwrite');
        tx.objectStore('actions').put(action);
        tx.oncomplete = () => r();
        tx.onerror = () => r();
      } catch (_) { r(); }
    });
  },

  async saveActions(actions) {
    if (!DB.db || !actions.length) return;
    return new Promise(r => {
      try {
        const tx = DB.db.transaction('actions', 'readwrite');
        const store = tx.objectStore('actions');
        for (const a of actions) store.put(a);
        tx.oncomplete = () => r();
        tx.onerror = () => r();
      } catch (_) { r(); }
    });
  },

  async getActions(sinceEpoch = 0) {
    if (!DB.db) return [];
    return new Promise(r => {
      try {
        const tx = DB.db.transaction('actions', 'readonly');
        const idx = tx.objectStore('actions').index('epoch');
        const range = IDBKeyRange.lowerBound(sinceEpoch);
        const results = [];
        const req = idx.openCursor(range);
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (cur) { results.push(cur.value); cur.continue(); }
          else r(results);
        };
        req.onerror = () => r([]);
      } catch (_) { r([]); }
    });
  },

  async getAllActions() {
    if (!DB.db) return [];
    return new Promise(r => {
      try {
        const tx = DB.db.transaction('actions', 'readonly');
        const req = tx.objectStore('actions').getAll();
        req.onsuccess = () => r(req.result || []);
        req.onerror = () => r([]);
      } catch (_) { r([]); }
    });
  },

  async deleteAction(id) {
    if (!DB.db) return;
    return new Promise(r => {
      try {
        const tx = DB.db.transaction('actions', 'readwrite');
        tx.objectStore('actions').delete(id);
        tx.oncomplete = () => r();
        tx.onerror = () => r();
      } catch (_) { r(); }
    });
  },

  async saveBlock(block) {
    if (!DB.db) return;
    return new Promise(r => {
      try {
        const tx = DB.db.transaction('blocks', 'readwrite');
        tx.objectStore('blocks').put(block);
        tx.oncomplete = () => r();
        tx.onerror = () => r();
      } catch (_) { r(); }
    });
  },

  async getBlocks(sinceEpoch = 0) {
    if (!DB.db) return [];
    return new Promise(r => {
      try {
        const tx = DB.db.transaction('blocks', 'readonly');
        const idx = tx.objectStore('blocks').index('epoch');
        const range = IDBKeyRange.lowerBound(sinceEpoch);
        const results = [];
        const req = idx.openCursor(range);
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (cur) { results.push(cur.value); cur.continue(); }
          else r(results);
        };
        req.onerror = () => r([]);
      } catch (_) { r([]); }
    });
  },

  // Remove corrupt DM channels (missing colon after dm)
  async cleanupCorrupt() {
    if (!DB.db) return;
    const chs = await this.getChannels();
    for (const ch of chs) {
      if (ch.name.startsWith('dm') && !ch.name.startsWith('dm:')) {
        try {
          const tx = DB.db.transaction('channels', 'readwrite');
          tx.objectStore('channels').delete(ch.name);
          await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
        } catch (_) {}
      }
    }
    // Also remove messages from corrupt channels
    const msgs = await this.getAllMsgs(9999);
    for (const m of msgs) {
      if (m.channel && m.channel.startsWith('dm') && !m.channel.startsWith('dm:')) {
        try {
          const tx = DB.db.transaction('messages', 'readwrite');
          tx.objectStore('messages').delete(m.msgId);
          await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
        } catch (_) {}
      }
    }
  },
};

// ═══════════════════════════════════════
// 3. ROUTING TABLE (Kademlia)
// ═══════════════════════════════════════
function xor(a, b) { let r = ''; for (let i = 0; i < a.length; i++) r += (parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16); return r; }
function hcmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function bktI(s, n) { for (let i = 0; i < s.length; i++) { const x = parseInt(s[i], 16) ^ parseInt(n[i], 16); if (x) return (s.length * 4) - 1 - (i * 4 + (3 - Math.floor(Math.log2(x)))); } return 0; }

class RT {
  constructor(s) { this.self = s; this.bkts = Array.from({ length: 160 }, () => []); this.all = new Map(); }
  add(n) {
    if (n.id === this.self) return;
    const i = bktI(this.self, n.id); if (i < 0) return;
    const b = this.bkts[i]; const p = b.findIndex(x => x.id === n.id);
    const entry = { ...n, seen: Date.now() };
    if (p >= 0) { b.splice(p, 1); b.push(entry); this.all.set(n.id, entry); return; }
    if (b.length < CFG.K) { b.push(entry); this.all.set(n.id, entry); return; }
    if (Date.now() - b[0].seen > CFG.TIMEOUT) { const o = b.shift(); this.all.delete(o.id); b.push(entry); this.all.set(n.id, entry); }
  }
  rm(id) { const i = bktI(this.self, id); if (i < 0) return; const b = this.bkts[i]; const p = b.findIndex(x => x.id === id); if (p >= 0) b.splice(p, 1); this.all.delete(id); }
  closest(t, c = CFG.K) { const l = []; for (const b of this.bkts) for (const n of b) l.push({ ...n, dist: xor(n.id, t) }); l.sort((a, b) => hcmp(a.dist, b.dist)); return l.slice(0, c); }
  nonEmpty() { const o = []; for (let i = 0; i < this.bkts.length; i++) if (this.bkts[i].length) o.push({ i, nodes: [...this.bkts[i]] }); return o; }
  get size() { return this.all.size; }
}

// ═══════════════════════════════════════
// 4. GOSSIP + LAMPORT CLOCK
// ═══════════════════════════════════════
class Gossip {
  constructor() { this.seen = new Map(); }
  has(id) { return this.seen.has(id); }
  mark(id) { this.seen.set(id, Date.now()); if (this.seen.size > CFG.MSG_CACHE) { const a = [...this.seen.entries()].sort((x, y) => x[1] - y[1]); for (let i = 0; i < a.length - CFG.MSG_CACHE; i++) this.seen.delete(a[i][0]); } }
  pick(peers, excl = []) { const p = peers.filter(x => !excl.includes(x.id)); for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p.slice(0, CFG.FANOUT); }
}

class LamportClock {
  constructor() { this.time = 0; }
  tick() { return ++this.time; }
  update(r) { this.time = Math.max(this.time, r) + 1; return this.time; }
}

// ═══════════════════════════════════════
// 5. MESSAGE STORE (per-channel, Lamport-ordered)
// ═══════════════════════════════════════
class MsgStore {
  constructor() { this.channels = new Map(); this.channels.set('general', []); }

  add(msg) {
    const ch = msg.channel || 'general';
    if (!this.channels.has(ch)) this.channels.set(ch, []);
    const arr = this.channels.get(ch);
    if (arr.some(m => m.msgId === msg.msgId)) return false;
    arr.push(msg);
    arr.sort((a, b) => (a.lamport - b.lamport) || (a.ts - b.ts));
    if (arr.length > CFG.HISTORY) arr.shift();
    // Persist to IndexedDB
    DB.saveMsg(msg);
    return true;
  }

  getChannel(ch) { return this.channels.get(ch) || []; }

  getAllChannels() {
    const result = [];
    for (const [name, msgs] of this.channels) result.push({ name, count: msgs.length });
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  getAll() {
    const all = [];
    for (const msgs of this.channels.values()) all.push(...msgs);
    return all;
  }

  merge(incoming) {
    let added = 0;
    for (const m of incoming) { if (this.add(m)) added++; }
    return added;
  }

  // Load from IndexedDB on startup
  async loadFromDB() {
    const msgs = await DB.getAllMsgs();
    for (const m of msgs) {
      const ch = m.channel || 'general';
      if (ch.startsWith('dm') && !ch.startsWith('dm:')) continue;
      if (!this.channels.has(ch)) this.channels.set(ch, []);
      const arr = this.channels.get(ch);
      if (!arr.some(x => x.msgId === m.msgId)) arr.push(m);
    }
    for (const arr of this.channels.values()) arr.sort((a, b) => (a.lamport - b.lamport) || (a.ts - b.ts));
    // Trim old messages from IndexedDB
    this._cleanupDB();
  }

  // Remove messages from IndexedDB that exceed HISTORY per channel
  async _cleanupDB() {
    let deleted = 0;
    for (const [ch, msgs] of this.channels) {
      if (msgs.length > CFG.HISTORY) {
        const excess = msgs.splice(0, msgs.length - CFG.HISTORY);
        for (const m of excess) {
          try { await DB.deleteMsg(m.msgId); deleted++; } catch (_) {}
        }
      }
    }
    if (deleted > 0) console.log(`DB cleanup: removed ${deleted} old messages`);
  }

  // Delete a specific message
  deleteMsg(msgId) {
    for (const [ch, msgs] of this.channels) {
      const idx = msgs.findIndex(m => m.msgId === msgId);
      if (idx >= 0) { msgs.splice(idx, 1); DB.deleteMsg(msgId); return true; }
    }
    return false;
  }
}

// ═══════════════════════════════════════
// 6. CHANNEL MANAGER
// ═══════════════════════════════════════
class ChannelMgr {
  constructor() { this.current = 'general'; this.joined = new Set(['general']); this.dmKeys = new Map(); }

  switchTo(ch) {
    // If it's a DM channel, don't sanitize — use as-is
    if (ch.startsWith('dm:')) {
      this.current = ch;
      this.joined.add(ch);
      DB.saveChannel({ name: ch, joinedAt: Date.now() });
      return ch;
    }
    // Public channel — sanitize name
    ch = ch.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!ch) return this.current;
    this.current = ch;
    this.joined.add(ch);
    DB.saveChannel({ name: ch, joinedAt: Date.now() });
    return ch;
  }

  // Create a DM channel name from two node IDs (deterministic, always sorted)
  dmChannel(myId, peerId) {
    const ids = [myId.slice(0, 8), peerId.slice(0, 8)].sort();
    return `dm:${ids[0]}-${ids[1]}`;
  }

  isDM(ch) { return ch.startsWith('dm:'); }

  list() { return [...this.joined]; }

  async loadFromDB() {
    const chs = await DB.getChannels();
    for (const ch of chs) {
      // Skip corrupt DM channels (missing colon)
      if (ch.name.startsWith('dm') && !ch.name.startsWith('dm:')) continue;
      this.joined.add(ch.name);
    }
  }

  // Remove corrupt channels
  cleanup() {
    const bad = [];
    for (const ch of this.joined) {
      if (ch.startsWith('dm') && !ch.startsWith('dm:')) bad.push(ch);
    }
    for (const ch of bad) this.joined.delete(ch);
  }
}

// ═══════════════════════════════════════
// 7. TRUST SYSTEM (Layer 6)
// ═══════════════════════════════════════
// Each peer earns trust through:
//   - Uptime: staying connected longer = more trust
//   - Relay: forwarding messages for others = more trust
//   - Consistency: stable behavior over time = more trust
// Trust decays over time if peer is inactive.
// Low-trust peers get rate-limited, very low get dropped.
// Peers share trust scores via heartbeat (social proof).

class TrustEngine {
  constructor() {
    this.scores = new Map();  // peerId -> TrustRecord
    this.localRates = new Map(); // peerId -> { msgs: [], window: 60000 }
    this.banList = new Set();
    this.banVotes = new Map(); // peerId -> Set of voterIds
  }

  // Get or create trust record for a peer
  _get(id) {
    if (!this.scores.has(id)) {
      this.scores.set(id, {
        id,
        score: 50,           // Start at neutral (0-100 scale)
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        msgsRelayed: 0,      // How many messages they relayed for us
        msgsReceived: 0,     // How many messages we received from them
        msgsDropped: 0,      // Messages we dropped (spam/invalid)
        connectionTime: 0,   // Total ms connected
        connectStart: 0,     // When current connection began
        violations: 0,       // Invalid signatures, spam attempts etc
        vouches: 0,          // How many other peers vouch for them
      });
    }
    return this.scores.get(id);
  }

  // ── EVENTS that affect trust ──

  // Peer connected to us
  onConnect(id) {
    const r = this._get(id);
    r.connectStart = Date.now();
    r.lastSeen = Date.now();
  }

  // Peer disconnected
  onDisconnect(id) {
    const r = this._get(id);
    if (r.connectStart > 0) {
      r.connectionTime += Date.now() - r.connectStart;
      r.connectStart = 0;
    }
    this._recalc(id);
    this._persist(id);
  }

  // We received a valid message from peer
  onMessageReceived(id) {
    const r = this._get(id);
    r.msgsReceived++;
    r.lastSeen = Date.now();
    // Small trust bump for valid messages
    r.score = Math.min(100, r.score + 0.1);
  }

  // Peer relayed a message (not their own) — good citizen behavior
  onRelay(id) {
    const r = this._get(id);
    r.msgsRelayed++;
    r.score = Math.min(100, r.score + 0.2);
  }

  // Message had invalid signature or was malformed
  onViolation(id) {
    const r = this._get(id);
    r.violations++;
    r.msgsDropped++;
    // Significant trust penalty
    r.score = Math.max(0, r.score - 5);
    this._persist(id);
  }

  // Spam detected — too many messages too fast
  onSpam(id) {
    const r = this._get(id);
    r.violations++;
    r.score = Math.max(0, r.score - 10);
    this._persist(id);
  }

  // Another peer vouches for this peer (via heartbeat trust sharing)
  onVouch(id, voucherId) {
    const r = this._get(id);
    // Only count vouches from peers we trust
    const voucherTrust = this.getScore(voucherId);
    if (voucherTrust >= 40) {
      r.vouches++;
      r.score = Math.min(100, r.score + 0.3);
    }
  }

  // ── RATE LIMITING ──

  // Check if a message from this peer should be accepted
  shouldAccept(id) {
    if (this.banList.has(id)) return false;
    const score = this.getScore(id);
    if (score < 10) return false; // Very low trust — drop all

    // Rate limit based on trust
    const limit = this._rateLimit(id);
    if (!this.localRates.has(id)) this.localRates.set(id, { msgs: [], window: 60000 });
    const rate = this.localRates.get(id);
    const now = Date.now();
    // Clean old entries
    rate.msgs = rate.msgs.filter(t => now - t < rate.window);
    if (rate.msgs.length >= limit) {
      this.onSpam(id);
      return false;
    }
    rate.msgs.push(now);
    return true;
  }

  // Messages per minute allowed, based on trust score
  _rateLimit(id) {
    const score = this.getScore(id);
    if (score >= 80) return 60;  // Highly trusted: 60 msgs/min
    if (score >= 50) return 30;  // Normal: 30 msgs/min
    if (score >= 30) return 15;  // Low trust: 15 msgs/min
    return 5;                     // Very low: 5 msgs/min
  }

  // ── BAN SYSTEM (community voting) ──

  // Vote to ban a peer (needs multiple votes)
  voteBan(peerId, voterId) {
    if (!this.banVotes.has(peerId)) this.banVotes.set(peerId, new Set());
    this.banVotes.get(peerId).add(voterId);
  }

  // Check if enough votes to ban (requires 3+ votes from trusted peers)
  checkBan(peerId, trustedPeerCount) {
    const votes = this.banVotes.get(peerId);
    if (!votes) return false;
    // Need at least 3 votes, or majority of trusted peers
    const threshold = Math.max(3, Math.floor(trustedPeerCount * 0.5));
    if (votes.size >= threshold) {
      this.banList.add(peerId);
      this.scores.delete(peerId);
      return true;
    }
    return false;
  }

  // ── SCORE CALCULATION ──

  getScore(id) {
    const r = this.scores.get(id);
    if (!r) return 50; // Unknown peers start neutral
    return Math.round(r.score);
  }

  // Recalculate trust based on all factors
  _recalc(id) {
    const r = this._get(id);
    let score = 50; // Base

    // Uptime bonus: up to +20 for long connection time
    const hours = r.connectionTime / 3600000;
    score += Math.min(20, hours * 2);

    // Relay bonus: up to +15 for relaying messages
    score += Math.min(15, r.msgsRelayed * 0.1);

    // Age bonus: up to +10 for being known a long time
    const daysSeen = (Date.now() - r.firstSeen) / 86400000;
    score += Math.min(10, daysSeen * 1);

    // Vouch bonus: up to +5
    score += Math.min(5, r.vouches * 0.5);

    // Violation penalty: -5 per violation
    score -= r.violations * 5;

    // Clamp 0-100
    r.score = Math.max(0, Math.min(100, score));
  }

  // ── TRUST SHARING (for heartbeat) ──

  // Get compact trust data to share with peers
  getShareable() {
    const data = [];
    for (const [id, r] of this.scores) {
      if (r.score >= 40) { // Only share peers we somewhat trust
        data.push({ id, score: Math.round(r.score) });
      }
    }
    return data.slice(0, 20); // Max 20 entries
  }

  // Merge trust data received from a peer
  mergeTrust(peerTrust, fromId) {
    if (!Array.isArray(peerTrust)) return;
    const fromScore = this.getScore(fromId);
    if (fromScore < 30) return; // Don't trust reports from untrusted peers

    for (const { id, score } of peerTrust) {
      if (typeof id !== 'string' || typeof score !== 'number') continue;
      const r = this._get(id);
      // Weighted merge: their opinion is weighted by their own trust
      const weight = fromScore / 100 * 0.1; // Max 10% influence
      r.score = Math.max(0, Math.min(100, r.score * (1 - weight) + score * weight));
    }
  }

  // ── PERSISTENCE ──

  async _persist(id) {
    const r = this.scores.get(id);
    if (r) await DB.setKey(`trust:${id}`, r);
  }

  async loadFromDB() {
    // Trust data is loaded lazily as peers connect
    // but we load ban list
    const bans = await DB.getKey('trust:bans');
    if (Array.isArray(bans)) for (const id of bans) this.banList.add(id);
  }

  async saveBans() {
    await DB.setKey('trust:bans', [...this.banList]);
  }

  // Get all scores for UI display
  getAllScores() {
    const list = [];
    for (const [id, r] of this.scores) {
      list.push({
        id, score: Math.round(r.score),
        msgsRelayed: r.msgsRelayed,
        violations: r.violations,
        connectionTime: r.connectionTime,
        banned: this.banList.has(id),
      });
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  }
}

// ═══════════════════════════════════════
// 8. MODERATION SYSTEM
// ═══════════════════════════════════════

const MOD_CFG = {
  MAX_MEDIA_SIZE: 5 * 1024 * 1024,
  REPORT_CONTEXT: 10,
};

class ModerationEngine {
  constructor() {
    this.admins = new Set();
    this.mods = new Set();          // Moderators — limited permissions
    this.isAdmin = false;
    this.isMod = false;
    this.reports = [];
    this.mediaQueue = new Map();
    this.approvedMedia = new Set();
    this.rejectedMedia = new Set();
    this.bannedWords = [];
    this.bannedWordsVersion = 0;
    // Custom ads — admin managed, shown while media pending
    this.customAds = [];            // [{ text, link, addedBy, ts }]
    this.defaultAds = [
      '📢 MeshChat — Decentralized Mesh Network',
      '🔐 End-to-End Encrypted Messaging',
      '🌐 No Servers. No Tracking. Pure P2P.',
    ];
  }

  setAdmin(nodeId) { this.admins.add(nodeId); DB.setKey('mod:admins', [...this.admins]); }

  // Mod management — only admin can add/remove mods
  addMod(nodeId) { this.mods.add(nodeId); DB.setKey('mod:mods', [...this.mods]); }
  removeMod(nodeId) { this.mods.delete(nodeId); DB.setKey('mod:mods', [...this.mods]); }

  async loadFromDB() {
    const admins = await DB.getKey('mod:admins');
    if (Array.isArray(admins)) for (const a of admins) this.admins.add(a);
    const mods = await DB.getKey('mod:mods');
    if (Array.isArray(mods)) for (const m of mods) this.mods.add(m);
    const approved = await DB.getKey('mod:approved');
    if (Array.isArray(approved)) for (const a of approved) this.approvedMedia.add(a);
    const rejected = await DB.getKey('mod:rejected');
    if (Array.isArray(rejected)) for (const a of rejected) this.rejectedMedia.add(a);
    const reports = await DB.getKey('mod:reports');
    if (Array.isArray(reports)) this.reports = reports;
    const bw = await DB.getKey('mod:bannedWords');
    if (bw && Array.isArray(bw.words)) {
      this.bannedWords = bw.words;
      this.bannedWordsVersion = bw.version || 0;
    }
    const ads = await DB.getKey('mod:ads');
    if (Array.isArray(ads)) this.customAds = ads;
    // Load media queue
    const mq = await DB.getKey('mod:mediaQueue');
    if (Array.isArray(mq)) for (const m of mq) this.mediaQueue.set(m.mediaId, m);
  }

  checkAdmin(nodeId) {
    this.isAdmin = this.admins.has(nodeId);
    this.isMod = this.mods.has(nodeId);
    return this.isAdmin;
  }

  // Can this node do moderation actions? (admin or mod)
  canModerate(nodeId) { return this.admins.has(nodeId) || this.mods.has(nodeId); }

  // ── CUSTOM ADS (admin-managed) ──
  // Types: text, script (JS injection), banner (image+link), html (raw HTML)
  // Placements: pending_image, plaza_feed, sidebar
  addAd(text, link, adminId, adType, placement, scriptCode) {
    this.customAds.push({
      text: text || '', link: link || '', addedBy: adminId, ts: Date.now(),
      adType: adType || 'text',
      placement: placement || 'pending_image',
      scriptCode: scriptCode || '',
    });
    DB.setKey('mod:ads', this.customAds);
  }

  removeAd(index) {
    if (index >= 0 && index < this.customAds.length) {
      this.customAds.splice(index, 1);
      DB.setKey('mod:ads', this.customAds);
    }
  }

  getAdPlaceholder(placement) {
    const target = placement || 'pending_image';
    const pool = this.customAds.filter(a => (a.placement || 'pending_image') === target);
    const ad = pool.length ? pool[Math.floor(Math.random() * pool.length)]
      : this.customAds.length ? this.customAds[Math.floor(Math.random() * this.customAds.length)] : null;
    if (!ad) {
      // No ads configured — only show fallback for pending_image
      if (target === 'pending_image') return '⏳ Media is being reviewed by admin...';
      return null; // No ad to show for plaza/sidebar
    }
    if (ad.adType === 'script') {
      // Use blob URL iframe — most reliable for 3rd party ad scripts
      const code = ad.scriptCode || ad.text;
      const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;overflow:hidden;background:transparent;display:flex;align-items:center;justify-content:center;min-height:50px;}</style></head><body>${code}</body></html>`;
      const id = 'adiframe-' + Math.random().toString(36).slice(2, 8);
      return `<div class="ad-script-slot" data-adhtml="${btoa(unescape(encodeURIComponent(html)))}" data-adiframe="${id}"><iframe id="${id}" class="ad-iframe" style="width:100%;min-height:250px;border:none;overflow:hidden;" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin" scrolling="no" frameborder="0"></iframe></div>`;
    }
    if (ad.adType === 'banner') return `<a href="${ad.link || '#'}" target="_blank" rel="noopener sponsored" style="display:block;"><img src="${ad.text}" style="max-width:100%;border-radius:6px;" alt="Ad"></a>`;
    if (ad.adType === 'html') return `<div class="ad-html-slot">${ad.scriptCode || ad.text}</div>`;
    return ad.link ? `<a href="${ad.link}" target="_blank" rel="noopener" style="color:var(--cyan);text-decoration:none;">${ad.text}</a>` : ad.text;
  }

  getAdsPacket() { return this.customAds; }

  // ── BANNED WORDS (admin-managed, synced to all peers) ──

  // Add a banned word/phrase. combo = optional second word for combo detection
  addBannedWord(word, combo, adminId) {
    word = word.toLowerCase().trim();
    if (!word) return;
    // No duplicates
    if (this.bannedWords.some(b => b.word === word && (b.combo || '') === (combo || ''))) return;
    this.bannedWords.push({
      word,
      combo: combo ? combo.toLowerCase().trim() : '',
      addedBy: adminId,
      ts: Date.now(),
    });
    this.bannedWordsVersion++;
    this._saveBannedWords();
  }

  removeBannedWord(index) {
    if (index >= 0 && index < this.bannedWords.length) {
      this.bannedWords.splice(index, 1);
      this.bannedWordsVersion++;
      this._saveBannedWords();
    }
  }

  _saveBannedWords() {
    DB.setKey('mod:bannedWords', { words: this.bannedWords, version: this.bannedWordsVersion });
  }

  // Get banned words list for syncing to other peers
  getBannedWordsPacket() {
    return { words: this.bannedWords, version: this.bannedWordsVersion };
  }

  // Merge banned words from another peer (accept if newer version)
  mergeBannedWords(packet) {
    if (!packet || !Array.isArray(packet.words)) return false;
    if ((packet.version || 0) <= this.bannedWordsVersion) return false;
    this.bannedWords = packet.words;
    this.bannedWordsVersion = packet.version;
    this._saveBannedWords();
    return true;
  }

  // Scan message text against dynamic banned words
  scanText(text) {
    if (!text || typeof text !== 'string' || !this.bannedWords.length) return { flagged: false };
    const lower = text.toLowerCase();
    for (const entry of this.bannedWords) {
      if (entry.combo) {
        // Combo: both words must appear in same message
        if (lower.includes(entry.word) && lower.includes(entry.combo)) {
          return { flagged: true, reason: `combo: "${entry.word}" + "${entry.combo}"` };
        }
      } else {
        // Single word/phrase match
        if (lower.includes(entry.word)) {
          return { flagged: true, reason: `banned: "${entry.word}"` };
        }
      }
    }
    return { flagged: false };
  }

  // Create report from a message with surrounding context
  createReport(msg, contextMsgs, reporterId, opts = {}) {
    return {
      id: `rpt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      reporterId,
      reportedUserId: msg.senderId,
      reportedUserName: msg.sender,
      targetMsg: { msgId: msg.msgId, text: msg.text, channel: msg.channel, ts: msg.ts },
      context: contextMsgs.slice(-MOD_CFG.REPORT_CONTEXT).map(m => ({
        sender: m.sender, senderId: m.senderId, text: m.text, ts: m.ts,
      })),
      createdAt: Date.now(),
      status: 'pending',
      autoFlagged: opts.auto || false,
      isDM: opts.isDM || false,
      reason: opts.reason || '',
    };
  }

  addReport(report) {
    if (this.reports.some(r => r.targetMsg.msgId === report.targetMsg.msgId)) return;
    this.reports.push(report);
    if (this.reports.length > 200) this.reports.shift();
    DB.setKey('mod:reports', this.reports);
  }

  reviewReport(reportId, action, adminId) {
    const r = this.reports.find(x => x.id === reportId);
    if (!r) return null;
    r.status = action; r.reviewedBy = adminId; r.reviewedAt = Date.now();
    DB.setKey('mod:reports', this.reports);
    return r;
  }

  getPendingReports() { return this.reports.filter(r => r.status === 'pending'); }

  // Media approval
  registerMedia(mediaId, senderName, senderId, channel, thumbData) {
    this.mediaQueue.set(mediaId, { mediaId, senderName, senderId, channel, thumb: thumbData, registeredAt: Date.now(), status: 'pending' });
    this._saveMediaQueue();
  }

  _saveMediaQueue() {
    DB.setKey('mod:mediaQueue', [...this.mediaQueue.values()]);
  }

  getMediaStatus(mediaId) {
    if (this.approvedMedia.has(mediaId)) return 'approved';
    if (this.rejectedMedia.has(mediaId)) return 'rejected';
    return 'pending';
  }

  approveMedia(mediaId) {
    this.approvedMedia.add(mediaId); this.mediaQueue.delete(mediaId); this.rejectedMedia.delete(mediaId);
    DB.setKey('mod:approved', [...this.approvedMedia]);
    this._saveMediaQueue();
  }

  rejectMedia(mediaId) {
    this.rejectedMedia.add(mediaId); this.mediaQueue.delete(mediaId); this.approvedMedia.delete(mediaId);
    DB.setKey('mod:rejected', [...this.rejectedMedia]);
    this._saveMediaQueue();
  }

  getPendingMedia() { return [...this.mediaQueue.values()].filter(m => m.status === 'pending'); }

  getAdminSummary() {
    return {
      pendingReports: this.getPendingReports().length,
      pendingMedia: this.getPendingMedia().length,
      totalReports: this.reports.length,
      approvedMedia: this.approvedMedia.size,
      rejectedMedia: this.rejectedMedia.size,
    };
  }
}

// ═══════════════════════════════════════
// 9. FILE TRANSFER (P2P chunked)
// ═══════════════════════════════════════
const FILE_CFG = {
  CHUNK_SIZE: 16384,
  MAX_SIZE: 10 * 1024 * 1024,
  THUMB_MAX: 150,        // smaller thumbnail for gossip efficiency
  THUMB_QUALITY: 0.4,    // more aggressive compression
};

class FileTransfer {
  constructor() {
    this.incoming = new Map();
    this.outgoing = new Map();
    this.fileCache = new Map();  // transferId -> { blob, meta } (completed files)
    this.seeders = new Map();    // transferId -> Set(peerId) — who has this file
  }

  async prepareFile(file) {
    if (file.size > FILE_CFG.MAX_SIZE) {
      return { error: `File too large (max ${FILE_CFG.MAX_SIZE / 1024 / 1024}MB)` };
    }
    const transferId = `ft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    const totalChunks = Math.ceil(data.length / FILE_CFG.CHUNK_SIZE);

    // Detect file type — mobile browsers may leave type empty
    let fileType = file.type || '';
    if (!fileType) {
      const ext = (file.name || '').split('.').pop()?.toLowerCase();
      const typeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
      fileType = typeMap[ext] || 'image/jpeg'; // default to jpeg since we only accept images
    }

    let thumb = '';
    if (fileType.startsWith('image/')) {
      try { thumb = await this.makeThumbnail(file); } catch(e) { console.error('Thumb error:', e); }
    }

    const meta = { transferId, fileName: file.name || 'image.jpg', fileSize: file.size, fileType, totalChunks, thumb };
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * FILE_CFG.CHUNK_SIZE;
      const end = Math.min(start + FILE_CFG.CHUNK_SIZE, data.length);
      const chunk = data.slice(start, end);
      // Safe base64 encoding (no spread operator — avoids stack overflow on large chunks)
      let binary = '';
      for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
      chunks.push(btoa(binary));
    }
    this.outgoing.set(transferId, { meta, chunks });

    // Cache our own file immediately
    const blob = new Blob([data], { type: file.type });
    this.fileCache.set(transferId, { blob, meta });
    this._cacheToDB(transferId, data, meta);

    return { meta, chunks };
  }

  receiveChunk(transferId, chunkIndex, chunkData, meta) {
    if (!this.incoming.has(transferId)) {
      this.incoming.set(transferId, { meta, chunks: new Array(meta.totalChunks).fill(null), received: 0 });
    }
    const transfer = this.incoming.get(transferId);
    if (!transfer.chunks[chunkIndex]) {
      transfer.chunks[chunkIndex] = chunkData;
      transfer.received++;
    }
    return { complete: transfer.received === transfer.meta.totalChunks, progress: transfer.received / transfer.meta.totalChunks };
  }

  assembleFile(transferId) {
    const transfer = this.incoming.get(transferId);
    if (!transfer || transfer.received !== transfer.meta.totalChunks) return null;
    const parts = [];
    for (const chunk of transfer.chunks) {
      const binary = atob(chunk);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      parts.push(bytes);
    }
    const totalLen = parts.reduce((a, p) => a + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) { result.set(p, offset); offset += p.length; }
    const blob = new Blob([result], { type: transfer.meta.fileType });

    // Cache the completed file — we are now a seeder
    this.fileCache.set(transferId, { blob, meta: transfer.meta });
    this._cacheToDB(transferId, result, transfer.meta);

    // Re-chunk for outgoing (so we can serve to others)
    const chunks = [];
    for (let i = 0; i < transfer.meta.totalChunks; i++) {
      chunks.push(transfer.chunks[i]);
    }
    this.outgoing.set(transferId, { meta: transfer.meta, chunks });

    this.incoming.delete(transferId);
    return { blob, meta: transfer.meta };
  }

  // Check if we have this file (can seed)
  hasFile(transferId) {
    return this.fileCache.has(transferId) || this.outgoing.has(transferId);
  }

  // Get chunks to serve to requester
  getChunks(transferId) {
    return this.outgoing.get(transferId);
  }

  // Register a peer as having a file
  addSeeder(transferId, peerId) {
    if (!this.seeders.has(transferId)) this.seeders.set(transferId, new Set());
    this.seeders.get(transferId).add(peerId);
  }

  // Get peers who have this file
  getSeeders(transferId) {
    return this.seeders.get(transferId) || new Set();
  }

  // Cache file to IndexedDB for persistence
  async _cacheToDB(transferId, data, meta) {
    try {
      if (!DB.db) return;
      const tx = DB.db.transaction('fileCache', 'readwrite');
      tx.objectStore('fileCache').put({ id: transferId, data: Array.from(data), meta, ts: Date.now() });
    } catch (_) {}
  }

  // Load cached file from IndexedDB
  async loadFromCache(transferId) {
    try {
      if (!DB.db) return null;
      return new Promise(r => {
        const tx = DB.db.transaction('fileCache', 'readonly');
        const req = tx.objectStore('fileCache').get(transferId);
        req.onsuccess = () => {
          if (req.result) {
            const bytes = new Uint8Array(req.result.data);
            const blob = new Blob([bytes], { type: req.result.meta.fileType });
            this.fileCache.set(transferId, { blob, meta: req.result.meta });
            // Also prepare chunks for outgoing
            const chunks = [];
            const totalChunks = req.result.meta.totalChunks;
            for (let i = 0; i < totalChunks; i++) {
              const start = i * FILE_CFG.CHUNK_SIZE;
              const end = Math.min(start + FILE_CFG.CHUNK_SIZE, bytes.length);
              const slice = bytes.slice(start, end);
              let binary = '';
              for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
              chunks.push(btoa(binary));
            }
            this.outgoing.set(transferId, { meta: req.result.meta, chunks });
            r({ blob, meta: req.result.meta });
          } else r(null);
        };
        req.onerror = () => r(null);
      });
    } catch (_) { return null; }
  }

  async makeThumbnail(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > FILE_CFG.THUMB_MAX || h > FILE_CFG.THUMB_MAX) {
          const r = Math.min(FILE_CFG.THUMB_MAX / w, FILE_CFG.THUMB_MAX / h);
          w *= r; h *= r;
        }
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', FILE_CFG.THUMB_QUALITY));
      };
      img.onerror = () => resolve('');
      img.src = URL.createObjectURL(file);
    });
  }
}

// ═══════════════════════════════════════
// 10. NETWORK GENESIS (conflict resolution)
// ═══════════════════════════════════════
// Every network has a unique genesis signed by its first admin.
// When two networks meet, the one with MORE ACTIVE PEERS wins.
// Tie-break: older genesis wins. Signature prevents timestamp forgery.

class NetworkGenesis {
  constructor() {
    this.networkId = '';
    this.genesisTime = 0;
    this.adminId = '';       // nodeId of founding admin
    this.adminName = '';
    this.signature = '';     // ECDSA signature over {networkId, genesisTime, adminId}
    this.peerCount = 0;      // Last known peer count (updated via heartbeat)
  }

  // Create a new genesis (only when founding a new network)
  async create(nodeId, nodeName, cryptoId) {
    this.networkId = `net-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.genesisTime = Date.now();
    this.adminId = nodeId;
    this.adminName = nodeName;
    // Sign the genesis so it can't be forged
    const payload = { networkId: this.networkId, genesisTime: this.genesisTime, adminId: this.adminId };
    this.signature = await cryptoId.sign(payload);
    await this._save();
    return this;
  }

  // Load from DB (returning peer restores their last known genesis)
  async loadFromDB() {
    const data = await DB.getKey('network:genesis');
    if (data) {
      this.networkId = data.networkId || '';
      this.genesisTime = data.genesisTime || 0;
      this.adminId = data.adminId || '';
      this.adminName = data.adminName || '';
      this.signature = data.signature || '';
      this.peerCount = data.peerCount || 0;
    }
    return this.networkId !== '';
  }

  async _save() {
    await DB.setKey('network:genesis', {
      networkId: this.networkId,
      genesisTime: this.genesisTime,
      adminId: this.adminId,
      adminName: this.adminName,
      signature: this.signature,
      peerCount: this.peerCount,
    });
  }

  // Get compact genesis for sharing in handshake
  toPacket() {
    return {
      networkId: this.networkId,
      genesisTime: this.genesisTime,
      adminId: this.adminId,
      adminName: this.adminName,
      signature: this.signature,
      peerCount: this.peerCount,
    };
  }

  // Adopt another network's genesis (we lost the conflict)
  async adopt(packet) {
    this.networkId = packet.networkId;
    this.genesisTime = packet.genesisTime;
    this.adminId = packet.adminId;
    this.adminName = packet.adminName || '';
    this.signature = packet.signature;
    this.peerCount = packet.peerCount || 0;
    await this._save();
  }

  // Compare two genesis: returns 'keep' if ours wins, 'adopt' if theirs wins
  // Rule: more peers wins. Tie: older genesis wins.
  compare(theirGenesis, ourPeerCount, theirPeerCount) {
    if (!theirGenesis || !theirGenesis.networkId) return 'keep';
    if (!this.networkId) return 'adopt';
    if (this.networkId === theirGenesis.networkId) return 'keep'; // Same network

    // Different networks — resolve conflict
    // 1. More peers wins (real network has more people)
    if (ourPeerCount !== theirPeerCount) {
      return ourPeerCount >= theirPeerCount ? 'keep' : 'adopt';
    }
    // 2. Tie: older genesis wins
    return this.genesisTime <= theirGenesis.genesisTime ? 'keep' : 'adopt';
  }
}

// ═══════════════════════════════════════
// 11. ACTION LOG — Unified event ledger
// ═══════════════════════════════════════
// Every mutation (msg, edit, delete, like, post, story, pin, etc.)
// is an Action in a single ordered log. State is derived from the log.

class ActionLog {
  constructor() {
    this.actions = new Map();  // id -> Action
    this.orphans = new Map();  // id -> Action (waiting for dependency)
    this.clock = new LamportClock();
    this._listeners = [];
  }

  // Create a new action
  create(type, data, opts = {}) {
    const id = `a-${(opts.senderId || '').slice(0,8)}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    return {
      id, type,
      channel: opts.channel || null,
      targetId: opts.targetId || null,
      senderId: opts.senderId || '',
      senderName: opts.senderName || '',
      data: data || {},
      ts: Date.now(),
      lamport: this.clock.tick(),
      epoch: Math.floor(Date.now() / CFG.EPOCH_MS),
      sig: null,
    };
  }

  // Add action — returns true if new
  add(action) {
    if (!action?.id) return false;
    if (this.actions.has(action.id)) return false;

    // Dependency check: some action types need their target to exist first
    if (action.targetId && this._needsDep(action)) {
      if (!this._hasTarget(action.targetId)) {
        this.orphans.set(action.id, action);
        console.log('ActionLog ORPHAN:', action.type, action.id.slice(0,12), 'waiting for', action.targetId?.slice(0,12));
        return true;
      }
    }

    // Skip if target already deleted (except delete actions — they always apply)
    if (action.targetId && !this._isDeleteType(action.type)) {
      if (this._isDeleted(action.targetId)) return false;
    }

    this.actions.set(action.id, action);
    this.clock.update(action.lamport || 0);
    DB.saveAction(action);
    this._resolveOrphans(action.id);
    this._notify(action);
    if (action.type === 'post-delete' || action.type === 'delete') {
      console.log('ActionLog DELETE applied:', action.type, 'target:', action.targetId?.slice(0,12), 'total actions:', this.actions.size);
    }
    return true;
  }

  // Merge from sync
  merge(incoming) {
    if (!Array.isArray(incoming)) return 0;
    const sorted = [...incoming].sort((a,b) => (a.lamport-b.lamport)||(a.ts-b.ts)||(a.senderId||'').localeCompare(b.senderId||''));
    let added = 0;
    for (const a of sorted) if (this.add(a)) added++;
    return added;
  }

  _isDeleteType(type) { return type === 'delete' || type === 'post-delete' || type === 'story-delete'; }

  _needsDep(action) {
    // Only these types need their target to exist first
    // Deletes are always accepted — if target hasn't arrived yet, it will be blocked by _isDeleted when it does
    return new Set(['edit','like','reaction','pin','unpin','poll-vote']).has(action.type);
  }

  _hasTarget(targetId) {
    if (this.actions.has(targetId)) return true;
    for (const [,a] of this.actions) {
      if (a.id === targetId) return true;
    }
    return false;
  }

  _isDeleted(targetId) {
    for (const [,a] of this.actions) {
      if (this._isDeleteType(a.type) && a.targetId === targetId) return true;
    }
    return false;
  }

  _resolveOrphans(newId) {
    const resolved = [];
    for (const [oid, orphan] of this.orphans) {
      if (orphan.targetId === newId || this._hasTarget(orphan.targetId)) resolved.push(oid);
    }
    for (const oid of resolved) {
      const o = this.orphans.get(oid);
      this.orphans.delete(oid);
      this.actions.set(oid, o);
      DB.saveAction(o);
      this._notify(o);
      this._resolveOrphans(oid);
    }
  }

  getSorted() {
    const arr = [...this.actions.values()];
    arr.sort((a,b) => (a.lamport-b.lamport)||(a.ts-b.ts)||(a.senderId||'').localeCompare(b.senderId||''));
    return arr;
  }

  getSince(sinceLamport) { return this.getSorted().filter(a => a.lamport > sinceLamport); }
  getEpochRange(from, to) { return this.getSorted().filter(a => a.epoch >= from && a.epoch <= to); }

  on(fn) { this._listeners.push(fn); }
  _notify(action) { for (const fn of this._listeners) try { fn(action); } catch(_){} }

  async loadFromDB() {
    const all = await DB.getAllActions();
    const cutoff = Date.now() - CFG.PRUNE_AGE;
    for (const a of all) {
      if (a.ts > cutoff) { this.actions.set(a.id, a); if (a.lamport > this.clock.time) this.clock.time = a.lamport; }
    }
    console.log(`ActionLog: ${this.actions.size} actions loaded`);
  }

  async prune() {
    const cutoff = Date.now() - CFG.PRUNE_AGE;
    let count = 0;
    for (const [id,a] of this.actions) { if (a.ts < cutoff) { this.actions.delete(id); DB.deleteAction(id); count++; } }
    if (count) console.log(`Pruned ${count} actions`);
  }

  get size() { return this.actions.size; }
}

// ═══════════════════════════════════════
// 12. BLOCK CHAIN — Epoch-based sync
// ═══════════════════════════════════════

class BlockChain {
  constructor(peerId) {
    this.peerId = peerId;
    this.blocks = new Map();
    this.latestEpoch = 0;
    this._timer = null;
  }

  static currentEpoch() { return Math.floor(Date.now() / CFG.EPOCH_MS); }

  async closeBlock(epoch, actions, prevHash) {
    const blockActions = actions.filter(a => a.epoch === epoch);
    if (!blockActions.length) return null;
    const payload = JSON.stringify(blockActions.map(a => a.id).sort());
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((prevHash||'0') + payload));
    const hash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2,'0')).join('');
    const block = {
      key: `${epoch}-${this.peerId}`, epoch, peerId: this.peerId,
      seq: this.blocks.size, prevHash: prevHash || '0',
      actionIds: blockActions.map(a => a.id), actionCount: blockActions.length,
      hash, closedAt: Date.now(),
    };
    this.blocks.set(block.key, block);
    if (epoch > this.latestEpoch) this.latestEpoch = epoch;
    await DB.saveBlock(block);
    return block;
  }

  getLatestHash() {
    let latest = null;
    for (const [,b] of this.blocks) { if (!latest || b.epoch > latest.epoch) latest = b; }
    return latest?.hash || '0';
  }

  getBlocksSince(sinceEpoch) {
    const r = [];
    for (const [,b] of this.blocks) if (b.epoch > sinceEpoch) r.push(b);
    r.sort((a,b) => a.epoch - b.epoch);
    return r;
  }

  async loadFromDB() {
    const all = await DB.getBlocks(0);
    for (const b of all) { this.blocks.set(b.key, b); if (b.epoch > this.latestEpoch) this.latestEpoch = b.epoch; }
    console.log(`BlockChain: ${this.blocks.size} blocks, epoch ${this.latestEpoch}`);
  }

  startClosing(actionLog) {
    this._timer = setInterval(async () => {
      const closable = Math.floor((Date.now() - CFG.EPOCH_DELAY) / CFG.EPOCH_MS);
      for (let e = this.latestEpoch + 1; e <= closable; e++) {
        const acts = actionLog.getEpochRange(e, e);
        if (acts.length) await this.closeBlock(e, acts, this.getLatestHash());
      }
      if (closable > this.latestEpoch) this.latestEpoch = closable;
    }, CFG.EPOCH_DELAY);
  }

  stop() { if (this._timer) clearInterval(this._timer); }
}

// ═══════════════════════════════════════
// 13. STATE BUILDER — Derives state from ActionLog
// ═══════════════════════════════════════

class StateBuilder {
  constructor(actionLog) {
    this.log = actionLog;
    this.messages = new Map();    // channel -> [msg objects]
    this.posts = [];
    this.stories = new Map();
    this.reactions = new Map();
    this.pins = {};
    this.profiles = new Map();
    this.polls = new Map();
    this._lastLamport = 0;
  }

  rebuild() {
    this.messages.clear(); this.posts = []; this.stories.clear();
    this.reactions.clear(); this.pins = {}; this.profiles.clear(); this.polls.clear();
    for (const a of this.log.getSorted()) this._apply(a);
    this._lastLamport = this.log.clock.time;
  }

  applyIncremental(action) { this._apply(action); }

  _apply(a) {
    switch(a.type) {
      case 'msg': {
        const ch = a.channel || 'general';
        if (!this.messages.has(ch)) this.messages.set(ch, []);
        const arr = this.messages.get(ch);
        if (!arr.some(m => m.msgId === a.id)) {
          arr.push({
            msgId: a.id, sender: a.senderName, senderId: a.senderId,
            text: a.data.text||'', ts: a.ts, lamport: a.lamport,
            channel: ch, hops: a.data.hops||0, type: a.data.isDM ? 'dm' : 'chat',
            _verified: a.data.verified ?? true, sig: a.sig,
            replyTo: a.data.replyTo||null, fileMeta: a.data.fileMeta||null,
            poll: a.data.poll||null, encrypted: a.data.encrypted||null,
            targetId: a.data.targetId||null, _plazaShare: a.data._plazaShare||null,
          });
          arr.sort((x,y) => (x.lamport-y.lamport)||(x.ts-y.ts));
          if (arr.length > CFG.HISTORY) arr.splice(0, arr.length - CFG.HISTORY);
        }
        if (a.data.poll) this.polls.set(a.id, a.data.poll);
        break;
      }
      case 'edit': {
        if (!a.targetId) break;
        for (const [,arr] of this.messages) {
          const msg = arr.find(m => m.msgId === a.targetId);
          if (msg) { msg.text = a.data.newText||msg.text; msg._edited = true; break; }
        }
        break;
      }
      case 'delete': {
        if (!a.targetId) break;
        for (const [,arr] of this.messages) {
          const idx = arr.findIndex(m => m.msgId === a.targetId);
          if (idx >= 0) { arr.splice(idx, 1); break; }
        }
        this.reactions.delete(a.targetId);
        break;
      }
      case 'post': {
        if (!this.posts.some(p => p.id === a.id)) {
          this.posts.push({
            id: a.id, senderId: a.senderId, senderName: a.senderName,
            text: a.data.text||'', ts: a.ts, likes: a.data.likes||[],
            thumb: a.data.thumb||null, imageId: a.data.imageId||null, image: a.data.image||null,
          });
          this.posts.sort((x,y) => y.ts - x.ts);
          if (this.posts.length > 500) this.posts = this.posts.slice(0,500);
        }
        break;
      }
      case 'post-delete': {
        if (a.targetId) this.posts = this.posts.filter(p => p.id !== a.targetId);
        break;
      }
      case 'like': {
        if (!a.targetId) break;
        const post = this.posts.find(p => p.id === a.targetId);
        if (post) {
          if (!post.likes) post.likes = [];
          const idx = post.likes.indexOf(a.senderId);
          if (a.data.toggle && idx < 0) post.likes.push(a.senderId);
          else if (!a.data.toggle && idx >= 0) post.likes.splice(idx, 1);
        }
        break;
      }
      case 'reaction': {
        if (!a.targetId || !a.data.emoji) break;
        if (!this.reactions.has(a.targetId)) this.reactions.set(a.targetId, {});
        const rm = this.reactions.get(a.targetId);
        if (!rm[a.data.emoji]) rm[a.data.emoji] = [];
        const ri = rm[a.data.emoji].indexOf(a.senderId);
        if (a.data.toggle && ri < 0) rm[a.data.emoji].push(a.senderId);
        else if (!a.data.toggle && ri >= 0) rm[a.data.emoji].splice(ri, 1);
        if (rm[a.data.emoji].length === 0) delete rm[a.data.emoji];
        break;
      }
      case 'story': {
        const key = a.data.storyKey || (a.senderId+'-'+a.ts);
        if (a.data.expiresAt && a.data.expiresAt > Date.now()) {
          this.stories.set(key, {
            senderId: a.senderId, senderName: a.senderName,
            senderEmoji: a.data.senderEmoji||'', text: a.data.text||'',
            bgColor: a.data.bgColor||'#22d3ee', image: a.data.image||null,
            ts: a.ts, expiresAt: a.data.expiresAt,
          });
        }
        break;
      }
      case 'story-delete': { if (a.targetId) this.stories.delete(a.targetId); break; }
      case 'pin': {
        if (!a.channel || !a.targetId) break;
        if (!this.pins[a.channel]) this.pins[a.channel] = [];
        if (a.data.action === 'pin') {
          if (!this.pins[a.channel].includes(a.targetId)) this.pins[a.channel].push(a.targetId);
          if (this.pins[a.channel].length > 3) this.pins[a.channel].shift();
        } else if (a.data.action === 'unpin') {
          this.pins[a.channel] = this.pins[a.channel].filter(id => id !== a.targetId);
        }
        break;
      }
      case 'profile': {
        const ex = this.profiles.get(a.senderId) || {};
        this.profiles.set(a.senderId, {
          ...ex,
          ...(a.data.bio !== undefined ? {bio:a.data.bio} : {}),
          ...(a.data.status !== undefined ? {status:a.data.status} : {}),
          ...(a.data.emoji !== undefined ? {emoji:a.data.emoji} : {}),
          ...(a.data.avatar !== undefined ? {avatar:a.data.avatar} : {}),
          name: a.senderName || ex.name || '', lastSeen: a.ts,
        });
        break;
      }
      case 'poll-vote': {
        if (!a.targetId) break;
        const poll = this.polls.get(a.targetId);
        if (poll) {
          // Check if poll expired
          if (poll.expiresAt && poll.expiresAt < Date.now()) break;

          if (poll.multiSelect) {
            // Multi-select: toggle this option without removing others
            const opt = poll.options[a.data.optIdx];
            if (opt) {
              if (!opt.votes) opt.votes = [];
              const vi = opt.votes.indexOf(a.senderId);
              if (vi >= 0) opt.votes.splice(vi, 1);
              else opt.votes.push(a.senderId);
            }
          } else {
            // Single-select: remove from all, add to selected
            for (const opt of poll.options) opt.votes = (opt.votes||[]).filter(v => v !== a.senderId);
            if (poll.options[a.data.optIdx]) {
              if (!poll.options[a.data.optIdx].votes) poll.options[a.data.optIdx].votes = [];
              poll.options[a.data.optIdx].votes.push(a.senderId);
            }
          }
          for (const [,arr] of this.messages) {
            const msg = arr.find(m => m.msgId === a.targetId);
            if (msg) { msg.poll = poll; break; }
          }
        }
        break;
      }
    }
  }

  // ── Compatibility API — old N.store interface ──
  getChannel(ch) { return this.messages.get(ch) || []; }
  getAllChannels() {
    const r = [];
    for (const [name,msgs] of this.messages) r.push({name, count:msgs.length});
    r.sort((a,b) => b.count - a.count);
    return r;
  }
  getAll() { const a = []; for (const m of this.messages.values()) a.push(...m); return a; }
  getUserPosts(sid) { return this.posts.filter(p => p.senderId === sid); }
  getActiveStories() {
    const now = Date.now(), a = [];
    for (const [k,s] of this.stories) { if (s.expiresAt > now) a.push({...s, key:k}); else this.stories.delete(k); }
    return a;
  }
  getProfile(pid) { return this.profiles.get(pid) || {bio:'',status:'offline',emoji:'',avatar:'',name:''}; }
  // Compat: deleteMsg for direct calls
  deleteMsg(msgId) {
    for (const [,arr] of this.messages) {
      const idx = arr.findIndex(m => m.msgId === msgId);
      if (idx >= 0) { arr.splice(idx,1); return true; }
    }
    return false;
  }
  // Compat: N.store.channels (Map access)
  get channels() { return this.messages; }
  // Compat: N.store.add (direct message add — used by topic set in ui.js)
  add(msg) {
    const ch = msg.channel || 'general';
    if (!this.messages.has(ch)) this.messages.set(ch, []);
    const arr = this.messages.get(ch);
    if (arr.some(m => m.msgId === msg.msgId)) return false;
    arr.push(msg);
    arr.sort((a,b) => (a.lamport-b.lamport)||(a.ts-b.ts));
    if (arr.length > CFG.HISTORY) arr.splice(0, arr.length - CFG.HISTORY);
    return true;
  }
  // Compat: merge for old-style history sync
  merge(incoming) {
    let added = 0;
    for (const m of incoming) { if (this.add(m)) added++; }
    return added;
  }
}
