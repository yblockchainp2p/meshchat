// ═══════════════════════════════════════
// MeshChat v1.2.6 — ActionLog Node
// ═══════════════════════════════════════
class Node {
  constructor() {
    this.id = null; this.name = ''; this.ws = null;
    this.crypto = new CryptoId();
    this.rt = null; this.gossip = new Gossip();
    this.chMgr = new ChannelMgr(); this.clock = new LamportClock();
    this.peers = new Map(); this.pending = new Map();
    this.peerKeys = new Map(); this.dmSecrets = new Map();
    this.ice = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
    this.gCnt = 0;
    this.trust = new TrustEngine(); this.mod = new ModerationEngine();
    this.ft = new FileTransfer(); this.genesis = new NetworkGenesis();
    this.blocked = new Set(); this.bookmarks = [];
    this._lastMsgTime = new Map(); this.mutedChannels = new Set();
    this.pendingAdminQueue = [];
    this.typing = new Map(); this.readReceipts = new Map();
    this.broadcastChannels = new Set();
    this.relayPeers = new Map(); this._relayCount = 0; this._relayResetTimer = null;
    // ActionLog
    this.actionLog = new ActionLog();
    this.chain = null;
    this.state = new StateBuilder(this.actionLog);
    this.store = this.state;
    this.reactions = this.state.reactions;
    this.pins = this.state.pins;
    this.profile = { bio: '', status: 'online', emoji: '', avatar: '', posts: [] };
    this.peerProfiles = new Map();
    this.stories = this.state.stories;
    // Crypto price engine
    this.crypto_price = new CryptoPrice();
  }

  async init(name) {
    this.name = name;
    await DB.open();
    await this.crypto.init();
    this.id = await this.crypto.nodeId();
    this.rt = new RT(this.id);
    this.chain = new BlockChain(this.id);
    await DB.setKey('username', name);
    await this.actionLog.loadFromDB();
    await this.chain.loadFromDB();
    this.state.rebuild();
    this._syncCompat();
    await this.chMgr.loadFromDB(); this.chMgr.cleanup();
    await this.trust.loadFromDB(); await this.mod.loadFromDB(); await this.genesis.loadFromDB();
    const blocked = await DB.getKey('blocked');
    if (Array.isArray(blocked)) for (const b of blocked) this.blocked.add(b);
    const bm = await DB.getKey('bookmarks');
    if (Array.isArray(bm)) this.bookmarks = bm;
    const sm = await DB.getKey('slowMode');
    if (sm && typeof sm === 'object') this._slowMode = sm;
    const dn = await DB.getKey('dmNames');
    if (dn && typeof dn === 'object') this._dmNames = new Map(Object.entries(dn));
    const muted = await DB.getKey('mutedChannels');
    if (Array.isArray(muted)) for (const m of muted) this.mutedChannels.add(m);
    const paq = await DB.getKey('pending:adminQueue');
    if (Array.isArray(paq)) this.pendingAdminQueue = paq;
    this._pruneAdminQueue();
    const prof = await DB.getKey('profile');
    if (prof && typeof prof === 'object') Object.assign(this.profile, prof);
    const bc = await DB.getKey('broadcastChannels');
    if (Array.isArray(bc)) for (const c of bc) this.broadcastChannels.add(c);
    this.mod.checkAdmin(this.id);
    this.clock.time = this.actionLog.clock.time;
    for (const [id] of this.actionLog.actions) this.gossip.mark(id);
    for (const [ch] of this.state.messages) this.chMgr.joined.add(ch);
    this.actionLog.on((a) => { this.state.applyIncremental(a); this._syncCompat(); });
    this.chain.startClosing(this.actionLog);
    setInterval(() => this.actionLog.prune(), 600000);
    this._sessionStart = Date.now();
    this._setStatus('reconnecting');
    this.connectBS(); this.startHB(); this.startRefresh(); this.startWakeDetection();
    const did = name + '#' + this.crypto.shortId;
    sys('🔑 ' + did + (this.mod.isAdmin ? ' · 🛡️ Admin' : ''));
    document.getElementById('idBadge').textContent = did;
    document.getElementById('idBadge').title = 'Public key: ' + this.crypto.pubKeyHex.slice(0,32) + '…';
    renderChannel(); refreshChannelList();
  }

  _syncCompat() {
    this.reactions = this.state.reactions;
    this.pins = this.state.pins;
    this.stories = this.state.stories;

    // FIRST: clear all posts in peerProfiles (prevents deleted posts surviving)
    for (const [, prof] of this.peerProfiles) {
      prof.posts = [];
    }

    // Sync profiles from state
    for (const [pid, p] of this.state.profiles) {
      if (pid !== this.id) {
        const ex = this.peerProfiles.get(pid) || {};
        this.peerProfiles.set(pid, { ...ex, ...p, posts: this.state.getUserPosts(pid) });
      } else {
        this.profile.bio = p.bio || this.profile.bio;
        this.profile.status = p.status || this.profile.status;
        this.profile.emoji = p.emoji || this.profile.emoji;
        this.profile.avatar = p.avatar || this.profile.avatar;
      }
    }

    // Repopulate posts for all post owners (including those without profile actions)
    const postOwners = new Set();
    for (const post of this.state.posts) { if (post.senderId) postOwners.add(post.senderId); }
    for (const pid of postOwners) {
      if (pid === this.id) continue;
      if (!this.peerProfiles.has(pid)) {
        const firstPost = this.state.posts.find(p => p.senderId === pid);
        this.peerProfiles.set(pid, { bio: '', status: 'offline', emoji: '', avatar: '', name: firstPost?.senderName || pid.slice(0,8), posts: this.state.getUserPosts(pid) });
      } else {
        this.peerProfiles.get(pid).posts = this.state.getUserPosts(pid);
      }
    }

    // Own posts
    this.profile.posts = this.state.getUserPosts(this.id);
  }

  async _emit(type, data, opts = {}) {
    const action = this.actionLog.create(type, data, { senderId: this.id, senderName: this.name, channel: opts.channel, targetId: opts.targetId });
    action.sig = await this.crypto.sign({ id: action.id, type: action.type, data: action.data, ts: action.ts, senderId: action.senderId });
    this.gossip.mark(action.id);
    this.actionLog.add(action);
    console.log('EMIT', type, action.id.slice(0,12), 'to', this.peers.size, 'peers');
    for (const [pid] of this.peers) this.sendTo(pid, { type: 'action', action, hops: 0 });
    return action;
  }

  async sendChat(text, replyTo) {
    const ch = this.chMgr.current;
    const slow = this.getSlowMode(ch);
    if (slow > 0 && !this.mod.isAdmin && !this.mod.isMod) {
      const last = this._lastSentTime?.[ch] || 0;
      if (Date.now() - last < slow * 1000) { sys('⏳ Slow mode'); return; }
    }
    if (!this._lastSentTime) this._lastSentTime = {};
    this._lastSentTime[ch] = Date.now();
    if (this.chMgr.isDM(ch)) { await this.sendDM(text, ch, replyTo); return; }
    const data = { text, hops: 0 };
    if (replyTo) data.replyTo = replyTo;
    const scan = this.mod.scanText(text);
    if (scan.flagged) this._autoReport({ sender: this.name, senderId: this.id, text, channel: ch, ts: Date.now() }, scan.reason);
    const a = await this._emit('msg', data, { channel: ch });
    showMsg({ sender: this.name, senderId: this.id, text, time: a.ts, route: 'self', hops: 0, self: true, channel: ch, verified: true, msgId: a.id, replyTo });
    refreshChannelList(); stats();
  }

  async sendDM(text, dmChannel, replyTo) {
    const parts = dmChannel.replace('dm:', '').split('-');
    let peerId = null;
    for (const [id] of this.peers) { if (parts.includes(id.slice(0,8))) { peerId = id; break; } }
    if (!peerId) for (const [id] of this.dmSecrets) { if (parts.includes(id.slice(0,8))) { peerId = id; break; } }
    const secret = peerId ? this.dmSecrets.get(peerId) : null;
    if (!secret) { sys('⚠ No encryption key'); return; }
    const encrypted = await this.crypto.encrypt(text, secret);
    const data = { text, encrypted, targetId: peerId, isDM: true, hops: 0 };
    if (replyTo) data.replyTo = replyTo;
    const a = await this._emit('msg', data, { channel: dmChannel });
    showMsg({ sender: this.name, senderId: this.id, text, time: a.ts, route: 'e2e', hops: 0, self: true, channel: dmChannel, verified: true, dm: true, msgId: a.id, replyTo });
    refreshChannelList(); stats();
  }

  async deleteMessage(msgId) {
    const msg = this.state.getAll().find(m => m.msgId === msgId);
    if (!msg) return;
    if (msg.senderId !== this.id && !this.mod.isAdmin && !this.mod.isMod) return;
    if (msg.fileMeta?.transferId) this._cleanFile(msg.fileMeta.transferId);
    await this._emit('delete', {}, { targetId: msgId, channel: msg.channel });
    scheduleRender();
  }

  async editMessage(msgId, newText) {
    const msg = this.state.getAll().find(m => m.msgId === msgId);
    if (!msg || msg.senderId !== this.id) return;
    await this._emit('edit', { newText }, { targetId: msgId, channel: msg.channel });
    scheduleRender();
  }

  async forwardMessage(msgId, targetChannel) {
    const msg = this.state.getAll().find(m => m.msgId === msgId);
    if (!msg) return;
    this.chMgr.switchTo(targetChannel); this.chMgr.current = targetChannel;
    await this.sendChat('↗ ' + msg.sender + ': ' + msg.text);
  }

  async sendReaction(msgId, emoji) {
    if (!msgId || !emoji) return;
    const rm = this.state.reactions.get(msgId) || {};
    const has = (rm[emoji] || []).includes(this.id);
    await this._emit('reaction', { emoji, toggle: !has }, { targetId: msgId });
    renderChannel();
  }

  async sendPoll(question, options, opts = {}) {
    const ch = this.chMgr.current;
    const poll = {
      question,
      options: options.map(o => ({ text: o, votes: [] })),
      multiSelect: opts.multiSelect || false,
      anonymous: opts.anonymous || false,
      expiresAt: opts.expiresAt || 0,
    };
    await this._emit('msg', { text: '📊 ' + question, poll, hops: 0 }, { channel: ch });
    refreshChannelList();
  }

  async votePoll(msgId, optIdx) { await this._emit('poll-vote', { optIdx }, { targetId: msgId }); renderChannel(); }

  async sendSocialPost(text, imageDataUrl) {
    if (!text?.trim() && !imageDataUrl) return;
    const data = { text: (text||'').trim().slice(0,500) };
    if (imageDataUrl) {
      const fid = 'plaza-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
      data.imageId = fid; data.thumb = imageDataUrl;
      try {
        const bin = atob(imageDataUrl.split(',')[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const meta = { transferId: fid, fileName: 'plaza.jpg', fileSize: bytes.length, fileType: 'image/jpeg', totalChunks: Math.ceil(bytes.length/16384), thumb: '' };
        this.ft.fileCache.set(fid, { blob, meta }); this.ft._cacheToDB(fid, bytes, meta);
        const chunks = [];
        for (let i = 0; i < meta.totalChunks; i++) {
          const s = i*16384, e = Math.min(s+16384, bytes.length), sl = bytes.slice(s,e);
          let b = ''; for (let j = 0; j < sl.length; j++) b += String.fromCharCode(sl[j]);
          chunks.push(btoa(b));
        }
        this.ft.outgoing.set(fid, { meta, chunks });
      } catch(_) { data.image = imageDataUrl; }
    }
    await this._emit('post', data);
    if (typeof refreshPlazaFeed === 'function') refreshPlazaFeed();
  }

  async deleteSocialPost(postId, ownerId) { await this._emit('post-delete', { ownerId }, { targetId: postId }); if (typeof refreshPlazaFeed === 'function') refreshPlazaFeed(); }
  async likeSocialPost(postId, ownerId) {
    const post = this.state.posts.find(p => p.id === postId);
    if (!post) return;
    const has = (post.likes||[]).includes(this.id);
    await this._emit('like', { toggle: !has }, { targetId: postId });
    if (typeof refreshPlazaFeed === 'function') refreshPlazaFeed();
  }

  async sendStory(text, bgColor, imageDataUrl) {
    if (!text?.trim() && !imageDataUrl) return;
    const data = { text: (text||'').trim().slice(0,280), bgColor: bgColor||'#22d3ee', senderEmoji: this.profile.emoji, expiresAt: Date.now()+24*3600000, storyKey: this.id+'-'+Date.now() };
    if (imageDataUrl) data.image = imageDataUrl;
    await this._emit('story', data); ui();
  }
  async deleteStory(storyKey) { await this._emit('story-delete', {}, { targetId: storyKey }); ui(); }
  async pinMessage(ch, msgId) { if (!this.mod.isAdmin && !this.mod.isMod) return; await this._emit('pin', { action: 'pin' }, { channel: ch, targetId: msgId }); renderChannel(); }
  async unpinMessage(ch, msgId) { if (!this.mod.isAdmin && !this.mod.isMod) return; await this._emit('pin', { action: 'unpin' }, { channel: ch, targetId: msgId }); renderChannel(); }
  async updateProfile(data) {
    if (data.bio !== undefined) this.profile.bio = data.bio.slice(0,150);
    if (data.status !== undefined) this.profile.status = data.status;
    if (data.emoji !== undefined) this.profile.emoji = data.emoji;
    if (data.avatar !== undefined) this.profile.avatar = data.avatar;
    DB.setKey('profile', this.profile);
    await this._emit('profile', { bio: this.profile.bio, status: this.profile.status, emoji: this.profile.emoji, avatar: this.profile.avatar });
  }

  // ═══ CRYPTO PRICE — P2P cached ═══
  async fetchCryptoPrice(ticker) {
    const t = ticker.toUpperCase();
    // 1. Check local cache
    const cached = this.crypto_price.get(t);
    if (cached) return cached;
    // 2. Fetch from CoinGecko
    const data = await this.crypto_price.fetch(t);
    if (data) {
      // 3. Gossip to all peers so they don't need to fetch
      this._broadcastCryptoPrice(t, data);
    }
    return data;
  }

  _broadcastCryptoPrice(ticker, data) {
    const msg = { type: 'crypto-price', ticker, data, hops: 0 };
    for (const [pid] of this.peers) this.sendTo(pid, msg);
  }

  _onCryptoPrice(d, from) {
    if (!d.ticker || !d.data) return;
    const t = d.ticker;
    // Handle both ticker ($BTC) and address (addr:0x...) keys
    if (t.startsWith('addr:')) {
      const addr = t.slice(5);
      this.crypto_price.addrCache.set(addr, { data: d.data, ts: Date.now() });
    } else {
      this.crypto_price.injectFromPeer(t.toUpperCase(), d.data);
    }
    // Re-gossip if hops < 3
    if ((d.hops || 0) < 3) {
      const fwd = { ...d, hops: (d.hops || 0) + 1 };
      const targets = this.gossip.pick([...this.peers.values()].map(p => p.info), [from]);
      for (const tgt of targets) this.sendTo(tgt.id, fwd);
    }
  }

  async fetchAddressInfo(addr) {
    // Check local cache first
    const cached = this.crypto_price.addrCache.get(addr);
    if (cached && Date.now() - cached.ts < CRYPTO_CFG.CACHE_TTL) return cached.data;
    // Fetch from CoinGecko contract API
    const data = await this.crypto_price.fetchByContract(addr);
    if (data) {
      // Gossip token data to peers
      this._broadcastCryptoPrice('addr:' + addr, data);
    }
    return data;
  }

  async sendFile(file) {
    const ch = this.chMgr.current;
    const result = await this.ft.prepareFile(file);
    if (result.error) { sys('⚠ ' + result.error); return; }
    const { meta, chunks } = result;
    window._fileUrls = window._fileUrls || {};
    window._fileUrls[meta.transferId] = { url: URL.createObjectURL(file), meta };
    this.mod.registerMedia(meta.transferId, this.name, this.id, ch, meta.thumb);
    if (this.mod.isAdmin || this.mod.isMod) this.mod.approveMedia(meta.transferId);
    const a = await this._emit('msg', { text: '', fileMeta: meta, hops: 0 }, { channel: ch });
    const isApproved = this.mod.approvedMedia.has(meta.transferId);
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'file-meta', meta, sender: this.name, senderId: this.id, channel: ch, msgId: a.id, approved: isApproved });
      for (let i = 0; i < chunks.length; i++) this.sendTo(pid, { type: 'file-chunk', transferId: meta.transferId, index: i, data: chunks[i], meta });
    }
    showMsg({ sender: this.name, senderId: this.id, text: '', time: a.ts, route: 'self', hops: 0, self: true, channel: ch, verified: true, msgId: a.id, fileMeta: meta });
    refreshChannelList(); stats();
  }

  // ═══ BOOTSTRAP + WEBRTC ═══
  _setStatus(s) { this._status = s; const t = document.getElementById('statusTag'); if (!t) return; t.textContent = 'v1.2.6'; t.className = s === 'connected' ? 'tag tag-on' : s === 'reconnecting' ? 'tag tag-warn' : 'tag tag-off'; }
  startWakeDetection() {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => this._checkAndReconnect(), 500); });
    let lt = Date.now(); setInterval(() => { const n = Date.now(), d = n-lt; lt = n; if (d > 8000) setTimeout(() => this._checkAndReconnect(), 500); }, 3000);
    window.addEventListener('online', () => setTimeout(() => this._checkAndReconnect(), 1000));
  }
  _checkAndReconnect() {
    const ws = this.ws && this.ws.readyState === WebSocket.OPEN;
    const pa = [...this.peers.values()].some(p => { try { return p.ch?.readyState === 'open'; } catch(_) { return false; } });
    if (!ws || !pa) this.reconnect();
    else { try { this.ws.send(JSON.stringify({ type: 'register', nodeId: this.id, username: this.name })); } catch(_) { this.reconnect(); } }
  }
  connectBS() {
    if (this._wsConnecting) return; this._wsConnecting = true;
    try { this.ws?.close(); } catch(_) {}
    this.ws = new WebSocket(BOOTSTRAP);
    this.ws.onopen = () => { this._wsConnecting = false; this._wsRetry = 1; this._bsFailed = false; this._setStatus('connected'); this.ws.send(JSON.stringify({ type: 'register', nodeId: this.id, username: this.name })); };
    this.ws.onmessage = (e) => { try { this.onBS(JSON.parse(e.data)); } catch(er) { console.error('WS:', er); } };
    this.ws.onclose = () => { this._wsConnecting = false; this._setStatus('disconnected'); const d = Math.min((this._wsRetry||1)*1000,10000); this._wsRetry = Math.min((this._wsRetry||1)*2,10); if (!this._bsFailed) { this._bsFailed = true; this._tryPeerCache(); } setTimeout(() => this.connectBS(), d); };
    this.ws.onerror = () => { this._wsConnecting = false; };
  }
  async _tryPeerCache() { try { const c = await DB.getPeers(); if (!c?.length) return; c.sort((a,b) => (b.lastSeen||0)-(a.lastSeen||0)); for (const p of c.slice(0,5)) { if (p.id===this.id||this.peers.has(p.id)||this.pending.has(p.id)) continue; if (this.peers.size>0) this._requestPeerRelay(p.id, p.name); } if (this.peers.size>0) this._setStatus('connected'); } catch(_) {} }
  _requestPeerRelay(tid, tn) { for (const [pid] of this.peers) { this.sendTo(pid, { type: 'signal-relay-request', targetId: tid, targetName: tn, fromId: this.id, fromName: this.name }); return; } }
  reconnect() { this._setStatus('reconnecting'); for (const [pid] of this.peers) this.drop(pid); for (const [pid] of this.pending) { try { this.pending.get(pid)?.pc?.close(); } catch(_) {} } this.pending.clear(); if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.connectBS(); else this.ws.send(JSON.stringify({ type: 'register', nodeId: this.id, username: this.name })); ui(); }
  onBS(m) { if (m.type==='peers') this.onList(m.peers||[],m); else if (m.type==='signal') this.onSig(m); else if (m.type==='peer-joined') this.onJoin(m); else if (m.type==='peer-left') this.onLeave(m); }
  async onList(data, fm) {
    const list = Array.isArray(data)?data:(data.peers||[]); const others = list.filter(p => p.nodeId!==this.id);
    for (const p of others) this.rt.add({ id: p.nodeId, name: p.username });
    if (!this.genesis.networkId && others.length===0) {
      if (fm?.cachedGenesis?.networkId) { await this.genesis.adopt(fm.cachedGenesis); if (Array.isArray(fm.cachedGenesis.admins)) { this.mod.admins = new Set(fm.cachedGenesis.admins); DB.setKey('mod:admins', fm.cachedGenesis.admins); } this.mod.checkAdmin(this.id); }
      else { await this.genesis.create(this.id, this.name, this.crypto); this.mod.admins = new Set([this.id]); this.mod.checkAdmin(this.id); DB.setKey('mod:admins', [this.id]); sys('🛡️ Network founded — you are admin'); this._sendToServer({ type: 'genesis-update', genesis: { ...this.genesis.toPacket(), admins: [...this.mod.admins] } }); }
    } else if (!this.genesis.networkId && others.length>0 && fm?.cachedGenesis?.networkId) { await this.genesis.adopt(fm.cachedGenesis); if (Array.isArray(fm.cachedGenesis.admins)) { this.mod.admins = new Set(fm.cachedGenesis.admins); DB.setKey('mod:admins', fm.cachedGenesis.admins); } this.mod.checkAdmin(this.id); }
    this.genesis.peerCount = this.peers.size;
    const tgts = this.rt.closest(this.id, CFG.MAX_PEERS);
    for (const t of tgts) { if (!this.peers.has(t.id) && !this.pending.has(t.id) && this.id < t.id) this.startConn(t.id, t.name); }
    this._setStatus('connected'); ui();
  }
  _sendToServer(d) { if (this.ws?.readyState===WebSocket.OPEN) try { this.ws.send(JSON.stringify(d)); } catch(_) {} }
  onJoin(m) { if (m.nodeId===this.id) return; this.rt.add({ id: m.nodeId, name: m.username }); if (this.peers.size < CFG.MAX_PEERS && !this.peers.has(m.nodeId) && !this.pending.has(m.nodeId) && this.id < m.nodeId) this.startConn(m.nodeId, m.username); ui(); }
  onLeave(m) { this.rt.rm(m.nodeId); this.drop(m.nodeId); ui(); }
  startConn(tid, tn) {
    if (this.peers.has(tid)||this.pending.has(tid)) return;
    const pc = new RTCPeerConnection(this.ice); this.pending.set(tid, { pc, name: tn, role: 'init' });
    const ch = pc.createDataChannel('mesh', { ordered: true }); this.wireCh(ch, tid, tn);
    pc.onicecandidate = (e) => { if (e.candidate) this.sig(tid, { type: 'candidate', candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState==='failed'||pc.connectionState==='closed') { this.pending.delete(tid); this.drop(tid); } };
    pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => this.sig(tid, { type: 'offer', sdp: pc.localDescription })).catch(e => { console.error('Offer:', e); this.pending.delete(tid); });
  }
  onSig(m) {
    const { from, fromName, signal } = m; if (from===this.id) return;
    if (signal.type==='offer') {
      if (this.peers.has(from)||this.pending.has(from)) return;
      const pc = new RTCPeerConnection(this.ice); this.pending.set(from, { pc, name: fromName, role: 'resp' });
      pc.ondatachannel = (e) => this.wireCh(e.channel, from, fromName);
      pc.onicecandidate = (e) => { if (e.candidate) this.sig(from, { type: 'candidate', candidate: e.candidate }); };
      pc.onconnectionstatechange = () => { if (pc.connectionState==='failed'||pc.connectionState==='closed') { this.pending.delete(from); this.drop(from); } };
      pc.setRemoteDescription(signal.sdp).then(() => pc.createAnswer()).then(a => pc.setLocalDescription(a)).then(() => this.sig(from, { type: 'answer', sdp: pc.localDescription })).catch(e => { console.error('Ans:', e); this.pending.delete(from); });
    } else if (signal.type==='answer') { const p = this.pending.get(from); if (p?.pc && p.role==='init' && p.pc.signalingState==='have-local-offer') p.pc.setRemoteDescription(signal.sdp).catch(e => console.error('SRD:', e)); }
    else if (signal.type==='candidate') { const t = this.pending.get(from)||this.peers.get(from); if (t?.pc) t.pc.addIceCandidate(signal.candidate).catch(e => console.error('ICE:', e)); }
  }

  // ═══ WIRE CHANNEL + CHAIN SYNC ═══
  async wireCh(ch, pid, pn) {
    ch.onopen = async () => {
      const p = this.pending.get(pid); const pc = p?.pc; this.pending.delete(pid);
      this.peers.set(pid, { pc, ch, info: { id: pid, name: pn }, seen: Date.now() });
      const pubKeys = await this.crypto.exportPublic();
      this.genesis.peerCount = this.peers.size;
      this.sendTo(pid, {
        type: 'handshake', nodeId: this.id, username: this.name, keys: pubKeys, nodes: this.snap(),
        genesis: this.genesis.toPacket(), admins: [...this.mod.admins], mods: [...this.mod.mods],
        bannedWords: this.mod.getBannedWordsPacket(), ads: this.mod.getAdsPacket(),
        mediaApprovals: [...this.mod.approvedMedia].slice(-200), mediaRejections: [...this.mod.rejectedMedia].slice(-200),
        slowMode: this._slowMode || {}, broadcastChannels: [...this.broadcastChannels],
        fileHaves: [...this.ft.fileCache.keys()].slice(-100),
        syncLamport: this.actionLog.clock.time, latestEpoch: this.chain.latestEpoch, latestHash: this.chain.getLatestHash(), actionCount: this.actionLog.size,
      });
      DB.savePeer({ id: pid, name: pn, lastSeen: Date.now() }); this.trust.onConnect(pid);
      for (const [tid] of this.ft.fileCache) this.sendTo(pid, { type: 'file-have', transferId: tid, seederId: this.id });
      console.log('Connected to ' + pn); ui();
    };
    ch.onmessage = (e) => { try { this.onPeerMsg(pid, JSON.parse(e.data)); } catch(er) { console.error('Parse:', er); } };
    ch.onclose = () => { this.drop(pid); ui(); };
  }
  drop(id) { this.trust.onDisconnect(id); const p = this.peers.get(id); if (p) { try { p.ch?.close(); } catch(_) {} try { p.pc?.close(); } catch(_) {} } this.peers.delete(id); this.pending.delete(id); }

  // ═══ PEER MESSAGE ROUTER ═══
  onPeerMsg(from, d) {
    const p = this.peers.get(from); if (p) p.seen = Date.now();
    switch(d.type) {
      case 'action': this._onAction(d, from); break;
      case 'chain-sync-request': this._onChainSyncReq(d, from); break;
      case 'chain-sync': this._onChainSync(d, from); break;
      case 'handshake': this.onHandshake(d, from); break;
      case 'typing': this.onTyping(d, from); break;
      case 'msg-ack': this.onMsgAck(d); break;
      case 'msg-read': this.onMsgRead(d); break;
      case 'heartbeat': this.onHB(d, from); break;
      case 'dht-lookup': this.onDHTLook(d, from); break;
      case 'dht-lookup-reply': this.onDHTReply(d); break;
      case 'file-meta': this.onFileMeta(d, from); break;
      case 'file-chunk': this.onFileChunk(d, from); break;
      case 'file-have': this._onFileHave(d, from); break;
      case 'file-request': this._onFileRequest(d, from); break;
      case 'mod-report': this.onModReport(d, from); break;
      case 'mod-action': this.onModAction(d, from); break;
      case 'mod-media': this.onModMedia(d, from); break;
      case 'mod-roles': this.onModRoles(d); break;
      case 'mod-ads': this.onModAds(d, from); break;
      case 'mod-banwords': this.onBanWords(d, from); break;
      case 'ban-vote': this.onBanVote(d, from); break;
      case 'slow-mode': if (d.channel && d.seconds!==undefined) { if (!this._slowMode) this._slowMode = {}; this._slowMode[d.channel] = d.seconds; DB.setKey('slowMode', this._slowMode); } break;
      case 'signal-relay-request': this._onRelayRequest(d, from); break;
      case 'signal-relay': this._onRelaySignal(d, from); break;
      case 'crypto-price': this._onCryptoPrice(d, from); break;
    }
  }

  // ═══ ACTION LOG PROTOCOL ═══
  _onAction(d, from) {
    const a = d.action; if (!a?.id) { console.warn('Action: no id'); return; }
    if (this.gossip.has(a.id)) { console.log('Action DUP:', a.id.slice(0,12)); return; } this.gossip.mark(a.id);
    if (this.blocked.has(a.senderId)) { console.log('Action BLOCKED:', a.senderId.slice(0,8)); return; }
    const lt = this._lastMsgTime.get(a.senderId)||0;
    if (Date.now()-lt < 300) { console.log('Action FLOOD:', a.senderId.slice(0,8)); return; } this._lastMsgTime.set(a.senderId, Date.now());
    if (!this.trust.shouldAccept(a.senderId)) { console.log('Action TRUST REJECT:', a.senderId.slice(0,8), 'score:', this.trust.getScore(a.senderId)); return; }
    // DM decrypt
    if (a.type==='msg' && a.data?.encrypted && a.data?.targetId===this.id) { this._decryptDM(a, from); return; }
    const added = this.actionLog.add(a);
    console.log('Action', a.type, a.id.slice(0,12), 'added:', added, 'from:', from.slice(0,8));
    if (added) {
      this.trust.onMessageReceived(a.senderId);
      if (from!==a.senderId) this.trust.onRelay(from);
      if (a.data?.text) { const sc = this.mod.scanText(a.data.text); if (sc.flagged) this._autoReport({ sender: a.senderName, senderId: a.senderId, text: a.data.text, channel: a.channel, ts: a.ts }, sc.reason); }
      if (a.channel) this.chMgr.joined.add(a.channel);
      this._notifyUI(a);
      if ((d.hops||0) < CFG.TTL) { const fwd = { type: 'action', action: a, hops: (d.hops||0)+1 }; const tg = this.gossip.pick([...this.peers.values()].map(p => p.info), [from, a.senderId]); for (const t of tg) this.sendTo(t.id, fwd); }
      this.gCnt++; stats();
    }
  }
  async _decryptDM(a, from) {
    const secret = this.dmSecrets.get(a.senderId); if (!secret||!a.data.encrypted) return;
    const text = await this.crypto.decrypt(a.data.encrypted.iv, a.data.encrypted.ct, secret);
    const dec = { ...a, data: { ...a.data, text } };
    if (this.actionLog.add(dec)) {
      const ch = a.channel || this.chMgr.dmChannel(this.id, a.senderId); this.chMgr.joined.add(ch);
      if (!this._dmNames) this._dmNames = new Map(); this._dmNames.set(a.senderId.slice(0,8), a.senderName); DB.setKey('dmNames', Object.fromEntries(this._dmNames));
      this.sendTo(from, { type: 'msg-ack', msgId: a.id }); this._notifyUI(dec);
    }
  }
  _notifyUI(a) {
    const ch = a.channel || 'general';
    if (a.type==='msg') {
      if (ch===this.chMgr.current) { const isDM = a.data?.isDM; showMsg({ sender: a.senderName, senderId: a.senderId, text: a.data?.text||'', time: a.ts, route: isDM?'e2e':'gossip', hops: a.data?.hops||0, self: false, channel: ch, verified: true, msgId: a.id, replyTo: a.data?.replyTo, fileMeta: a.data?.fileMeta, dm: isDM }); }
      else if (!this.mutedChannels.has(ch)) { const m = a.data?.text && (a.data.text.includes('@'+this.name)||a.data.text.includes('@'+this.crypto.shortId)); showToast(a.senderName, a.data?.text||'', m?'mention':a.data?.isDM?'dm':'chat', ch); }
      refreshChannelList();
    } else if (a.type==='post') { if (typeof refreshPlazaFeed==='function') refreshPlazaFeed(); }
    else if (a.type==='delete'||a.type==='edit'||a.type==='reaction'||a.type==='pin') scheduleRender();
    else if (a.type==='story'||a.type==='story-delete') ui();
    else if (a.type==='post-delete'||a.type==='like') {
      // Force full rebuild to ensure post deletion propagates to all compat layers
      this.state.rebuild();
      this._syncCompat();
      if (typeof refreshPlazaFeed==='function') refreshPlazaFeed();
    }
    else if (a.type==='profile') ui();
  }

  // ═══ CHAIN SYNC ═══
  _onChainSyncReq(d, from) {
    const acts = this.actionLog.getSince(d.sinceLamport||0);
    for (let i = 0; i < acts.length; i += 200) this.sendTo(from, { type: 'chain-sync', actions: acts.slice(i, i+200), total: acts.length });
    console.log('Chain sync: sent ' + acts.length + ' to ' + from.slice(0,8));
  }
  _onChainSync(d, from) {
    if (!Array.isArray(d.actions)) return;
    const added = this.actionLog.merge(d.actions);
    // Always rebuild state after sync for consistency
    this.state.rebuild();
    this._syncCompat();
    scheduleRender();
    refreshChannelList();
    if (typeof refreshPlazaFeed === 'function') refreshPlazaFeed();
    if (added > 0) console.log('Chain sync: +' + added + ' from ' + from.slice(0,8) + ' | posts:' + this.state.posts.length);
  }

  // ═══ HANDSHAKE ═══
  async onHandshake(d, from) {
    if (d.keys) { this.peerKeys.set(d.nodeId||from, d.keys); try { const s = await this.crypto.deriveShared(d.keys.dh); this.dmSecrets.set(d.nodeId||from, s); } catch(_) {} }
    if (d.nodes) for (const n of d.nodes) this.rt.add(n);
    if (d.genesis?.networkId) {
      if (!this.genesis.networkId) { await this.genesis.adopt(d.genesis); this._adoptNet(d); }
      else if (this.genesis.networkId!==d.genesis.networkId) { if (this.genesis.compare(d.genesis, this.peers.size, d.genesis.peerCount||0)==='adopt') { await this.genesis.adopt(d.genesis); this._adoptNet(d); } }
      else { if (d.bannedWords) this.mod.mergeBannedWords(d.bannedWords); if (Array.isArray(d.ads)&&d.ads.length) this.mod.customAds = d.ads; }
    }
    this.mod.checkAdmin(this.id);
    const peer = this.peers.get(from); if (peer && d.username) peer.info.name = d.username;
    const sid = d.nodeId||from;
    if (Array.isArray(d.mediaApprovals)) { for (const m of d.mediaApprovals) this.mod.approvedMedia.add(m); DB.setKey('mod:approved', [...this.mod.approvedMedia]); }
    if (Array.isArray(d.mediaRejections)) { for (const m of d.mediaRejections) this.mod.rejectedMedia.add(m); DB.setKey('mod:rejected', [...this.mod.rejectedMedia]); }
    if (d.slowMode && typeof d.slowMode==='object') { if (!this._slowMode) this._slowMode = {}; for (const [ch,sec] of Object.entries(d.slowMode)) if (typeof sec==='number') this._slowMode[ch] = sec; DB.setKey('slowMode', this._slowMode); }
    if (Array.isArray(d.broadcastChannels)) { for (const c of d.broadcastChannels) this.broadcastChannels.add(c); DB.setKey('broadcastChannels', [...this.broadcastChannels]); }
    if (Array.isArray(d.fileHaves)) { for (const t of d.fileHaves) this.ft.addSeeder(t, sid); }
    // Chain sync
    const theirL = d.syncLamport||0, myL = this.actionLog.clock.time;
    console.log('Handshake sync:', 'myLamport:', myL, 'theirLamport:', theirL, 'myActions:', this.actionLog.size);
    if (theirL > myL) this.sendTo(from, { type: 'chain-sync-request', sinceLamport: myL });
    if (myL > theirL) { const m = this.actionLog.getSince(theirL); console.log('Sending', m.length, 'actions to', from.slice(0,8)); for (let i = 0; i < m.length; i += 200) this.sendTo(from, { type: 'chain-sync', actions: m.slice(i, i+200), total: m.length }); }
    if (this.mod.admins.has(sid)||this.mod.mods.has(sid)) setTimeout(() => this._flushToAdmin(from), 300);
    ui();
  }
  _adoptNet(d) {
    if (Array.isArray(d.admins)) { this.mod.admins = new Set(d.admins); DB.setKey('mod:admins', d.admins); }
    if (Array.isArray(d.mods)) { this.mod.mods = new Set(d.mods); DB.setKey('mod:mods', d.mods); }
    if (d.bannedWords) this.mod.mergeBannedWords(d.bannedWords);
    if (Array.isArray(d.ads)) { this.mod.customAds = d.ads; DB.setKey('mod:ads', d.ads); }
    this.mod.checkAdmin(this.id);
  }

  // ═══ EPHEMERAL ═══
  sendTyping(ch) { if (!this._lastTypingSent||Date.now()-this._lastTypingSent>2000) { this._lastTypingSent = Date.now(); for (const [pid] of this.peers) this.sendTo(pid, { type: 'typing', channel: ch, senderId: this.id, senderName: this.name }); } }
  onTyping(d, from) { if (!d.channel||!d.senderName) return; if (!this.typing.has(d.channel)) this.typing.set(d.channel, new Map()); this.typing.get(d.channel).set(d.senderId||from, { name: d.senderName, ts: Date.now() }); if (typeof updateTypingUI==='function') updateTypingUI(); }
  getTypingUsers(ch) { const m = this.typing.get(ch); if (!m) return []; const now = Date.now(), a = []; for (const [pid, info] of m) { if (now-info.ts<3500&&pid!==this.id) a.push(info.name); else m.delete(pid); } return a; }
  sendAck(msgId, from) { this.sendTo(from, { type: 'msg-ack', msgId }); }
  sendReadReceipt(ch) { if (!this.chMgr.isDM(ch)) return; const msgs = this.state.getChannel(ch); for (const m of msgs) { if (m.senderId!==this.id&&!m._read) { m._read = true; for (const [pid] of this.peers) { if (pid===m.senderId||m.senderId?.startsWith(pid?.slice(0,8))) this.sendTo(pid, { type: 'msg-read', msgId: m.msgId }); } } } }
  onMsgAck(d) { const r = this.readReceipts.get(d.msgId)||{}; r.delivered = true; this.readReceipts.set(d.msgId, r); scheduleRender(); }
  onMsgRead(d) { const r = this.readReceipts.get(d.msgId)||{}; r.delivered = true; r.read = true; this.readReceipts.set(d.msgId, r); scheduleRender(); }

  // ═══ FILE TRANSFER ═══
  onFileMeta(d, from) { if (!d.meta) return; if (d.approved) this.mod.approveMedia(d.meta.transferId); else { this.mod.registerMedia(d.meta.transferId, d.sender||'?', d.senderId||from, d.channel||'general', d.meta.thumb||''); if (this.mod.isAdmin||this.mod.isMod) { setAdminAlert(true); showToast('📸 Media', (d.sender||'Someone')+' sent media', 'mention', null); } } }
  onFileChunk(d, from) { if (!d.transferId||d.index===undefined||!d.data) return; const r = this.ft.receiveChunk(d.transferId, d.index, d.data, d.meta); if (r.complete) { const f = this.ft.assembleFile(d.transferId); if (f) { window._fileUrls = window._fileUrls||{}; window._fileUrls[d.transferId] = { url: URL.createObjectURL(f.blob), meta: f.meta }; this.ft.addSeeder(d.transferId, this.id); for (const [pid] of this.peers) this.sendTo(pid, { type: 'file-have', transferId: d.transferId, seederId: this.id }); scheduleRender(); } } }
  _onFileHave(d, from) { if (!d.transferId||!d.seederId) return; this.ft.addSeeder(d.transferId, d.seederId); for (const [pid] of this.peers) { if (pid!==from) this.sendTo(pid, d); } }
  _onFileRequest(d, from) { if (!d.transferId) return; const f = this.ft.getChunks(d.transferId); if (!f) return; this.sendTo(from, { type: 'file-meta', meta: f.meta, sender: '', senderId: this.id, channel: '', msgId: '', approved: true }); for (let i = 0; i < f.chunks.length; i++) this.sendTo(from, { type: 'file-chunk', transferId: d.transferId, index: i, data: f.chunks[i], meta: f.meta }); }
  requestFile(tid) { if (window._fileUrls?.[tid]) return; if (this.ft.hasFile(tid)) { const c = this.ft.fileCache.get(tid); if (c) { window._fileUrls = window._fileUrls||{}; window._fileUrls[tid] = { url: URL.createObjectURL(c.blob), meta: c.meta }; scheduleRender(); return; } } this.ft.loadFromCache(tid).then(r => { if (r) { window._fileUrls = window._fileUrls||{}; window._fileUrls[tid] = { url: URL.createObjectURL(r.blob), meta: r.meta }; scheduleRender(); } else { for (const [pid] of this.peers) this.sendTo(pid, { type: 'file-request', transferId: tid }); } }); }
  _cleanFile(tid) { this.ft.fileCache.delete(tid); this.ft.outgoing.delete(tid); this.mod.approvedMedia.delete(tid); this.mod.rejectedMedia.delete(tid); if (window._fileUrls?.[tid]) { try { URL.revokeObjectURL(window._fileUrls[tid].url); } catch(_) {} delete window._fileUrls[tid]; } }

  // ═══ MODERATION ═══
  _autoReport(msg, reason) { const ctx = this.state.getChannel(msg.channel||'general'); const r = this.mod.createReport(msg, ctx, this.id, { auto: true, reason }); this.mod.addReport(r); this._sendToAdmins({ type: 'mod-report', report: r }); }
  onModReport(d, from) { if (!this.mod.isAdmin&&!this.mod.isMod) { this._sendToAdmins(d); return; } if (d.report) { this.mod.addReport(d.report); setAdminAlert(true); showToast('⚠ Report', d.report.targetMsg?.text||'New report', 'mention', null); } ui(); }
  onModAction(d, from) { if (d.action==='ban'&&d.reportId) { const r = this.mod.reports.find(x => x.id===d.reportId); if (r) { this.trust.banList.add(r.reportedUserId); this.trust.saveBans(); } } for (const [pid] of this.peers) { if (pid!==from) this.sendTo(pid, d); } }
  onModMedia(d, from) { if (d.approved) this.mod.approveMedia(d.mediaId); else this.mod.rejectMedia(d.mediaId); for (const [pid] of this.peers) { if (pid!==from) this.sendTo(pid, d); } scheduleRender(); }
  onModRoles(d) { if (Array.isArray(d.admins)) { this.mod.admins = new Set(d.admins); DB.setKey('mod:admins', d.admins); } if (Array.isArray(d.mods)) { this.mod.mods = new Set(d.mods); DB.setKey('mod:mods', d.mods); } this.mod.checkAdmin(this.id); ui(); }
  onModAds(d, from) { if (Array.isArray(d.ads)) { this.mod.customAds = d.ads; DB.setKey('mod:ads', d.ads); for (const [pid] of this.peers) { if (pid!==from) this.sendTo(pid, d); } } }
  onBanWords(d, from) { if (d.bannedWords&&this.mod.mergeBannedWords(d.bannedWords)) { for (const [pid] of this.peers) { if (pid!==from) this.sendTo(pid, d); } ui(); } }
  onBanVote(d, from) { if (this.trust.getScore(from)<30) return; this.trust.voteBan(d.targetId, d.voterId); const tc = [...this.peers.values()].filter(p => this.trust.getScore(p.info.id)>=40).length; if (this.trust.checkBan(d.targetId, tc)) this.trust.saveBans(); for (const [pid] of this.peers) { if (pid!==from) this.sendTo(pid, d); } }
  reportPeer(pid) { this.trust.voteBan(pid, this.id); this.trust.onViolation(pid); for (const [p] of this.peers) this.sendTo(p, { type: 'ban-vote', targetId: pid, voterId: this.id }); const tc = [...this.peers.values()].filter(p => this.trust.getScore(p.info.id)>=40).length; if (this.trust.checkBan(pid, tc)) { this.trust.saveBans(); sys('🚫 ' + pid.slice(0,8) + ' banned'); } ui(); }
  reportMessage(msg) { const ctx = this.state.getChannel(msg.channel||'general'); const r = this.mod.createReport(msg, ctx, this.id, { isDM: this.chMgr.isDM(msg.channel), reason: 'User report' }); if (this.mod.isAdmin) { this.mod.addReport(r); ui(); return; } this._sendToAdmins({ type: 'mod-report', report: r }); sys('⚑ Report sent'); }
  adminAction(rid, act) { if (!this.mod.isAdmin) return; const r = this.mod.reviewReport(rid, act, this.id); if (!r) return; if (act==='ban') { this.trust.banList.add(r.reportedUserId); this.trust.saveBans(); for (const [pid] of this.peers) this.sendTo(pid, { type: 'ban-vote', targetId: r.reportedUserId, voterId: this.id }); sys('🚫 ' + r.reportedUserName + ' banned'); } for (const [pid] of this.peers) this.sendTo(pid, { type: 'mod-action', reportId: rid, action: act, adminId: this.id }); ui(); }
  adminMediaAction(mid, approve) { if (!this.mod.isAdmin&&!this.mod.isMod) return; if (approve) this.mod.approveMedia(mid); else this.mod.rejectMedia(mid); for (const [pid] of this.peers) this.sendTo(pid, { type: 'mod-media', mediaId: mid, approved: approve }); renderChannel(); ui(); }
  adminAddBannedWord(w, c) { if (!this.mod.isAdmin) return; this.mod.addBannedWord(w, c, this.id); this._broadcastBW(); }
  adminRemoveBannedWord(i) { if (!this.mod.isAdmin) return; this.mod.removeBannedWord(i); this._broadcastBW(); }
  adminAddMod(pid) { if (!this.mod.isAdmin) return; this.mod.addMod(pid); this._broadcastRoles(); }
  adminRemoveMod(pid) { if (!this.mod.isAdmin) return; this.mod.removeMod(pid); this._broadcastRoles(); }
  adminAddAd(text, link, adType, placement, scriptCode) { if (!this.mod.isAdmin) return; this.mod.addAd(text, link, this.id, adType, placement, scriptCode); this._broadcastAds(); }
  adminRemoveAd(i) { if (!this.mod.isAdmin) return; this.mod.removeAd(i); this._broadcastAds(); }
  _broadcastRoles() { for (const [pid] of this.peers) this.sendTo(pid, { type: 'mod-roles', admins: [...this.mod.admins], mods: [...this.mod.mods] }); this._sendToServer({ type: 'genesis-update', genesis: { ...this.genesis.toPacket(), admins: [...this.mod.admins] } }); }
  _broadcastAds() { for (const [pid] of this.peers) this.sendTo(pid, { type: 'mod-ads', ads: this.mod.getAdsPacket() }); }
  _broadcastBW() { for (const [pid] of this.peers) this.sendTo(pid, { type: 'mod-banwords', bannedWords: this.mod.getBannedWordsPacket() }); }
  _sendToAdmins(d) { for (const [pid] of this.peers) { if (this.mod.admins.has(pid)||this.mod.mods.has(pid)) { this.sendTo(pid, d); return; } } this._queueForAdmin(d); for (const [pid] of this.peers) { this.sendTo(pid, d); return; } }
  _queueForAdmin(d) { const qId = d.report?.id||d.reportId||'q-'+Date.now(); if (this.pendingAdminQueue.some(q => q.id===qId)) return; this.pendingAdminQueue.push({ id: qId, data: d, ts: Date.now() }); this._pruneAdminQueue(); DB.setKey('pending:adminQueue', this.pendingAdminQueue); }
  _pruneAdminQueue() { const c = Date.now()-24*3600000; this.pendingAdminQueue = this.pendingAdminQueue.filter(q => q.ts>c).slice(-50); }
  _flushToAdmin(pid) { if (!this.mod.admins.has(pid)&&!this.mod.mods.has(pid)) return; if (!this.pendingAdminQueue.length) return; const p = this.peers.get(pid); if (!p||p.ch?.readyState!=='open') return; for (const q of this.pendingAdminQueue) this.sendTo(pid, q.data); this.pendingAdminQueue = []; DB.setKey('pending:adminQueue', []); }

  // ═══ MISC ═══
  async startDM(pid) { const peer = this.peers.get(pid)||{info:{name:'unknown'}}; const pn = peer.info?.name||this.rt.all.get(pid)?.name||'unknown'; const ch = this.chMgr.dmChannel(this.id, pid); this.chMgr.switchTo(ch); if (!this._dmNames) this._dmNames = new Map(); this._dmNames.set(pid.slice(0,8), pn); DB.setKey('dmNames', Object.fromEntries(this._dmNames)); if (!this.state.messages.has(ch)) this.state.messages.set(ch, []); renderChannel(); refreshChannelList(); closeMobileDrawer(); }
  blockUser(uid) { this.blocked.add(uid); DB.setKey('blocked', [...this.blocked]); }
  unblockUser(uid) { this.blocked.delete(uid); DB.setKey('blocked', [...this.blocked]); }
  isBlocked(uid) { return this.blocked.has(uid); }
  addBookmark(msgId) { const msg = this.state.getAll().find(m => m.msgId===msgId); if (!msg||this.bookmarks.some(b => b.msgId===msgId)) return; this.bookmarks.push({ msgId, text: msg.text, sender: msg.sender, channel: msg.channel, ts: msg.ts }); if (this.bookmarks.length>50) this.bookmarks.shift(); DB.setKey('bookmarks', this.bookmarks); }
  removeBookmark(msgId) { this.bookmarks = this.bookmarks.filter(b => b.msgId!==msgId); DB.setKey('bookmarks', this.bookmarks); }
  muteChannel(ch) { this.mutedChannels.add(ch); DB.setKey('mutedChannels', [...this.mutedChannels]); }
  unmuteChannel(ch) { this.mutedChannels.delete(ch); DB.setKey('mutedChannels', [...this.mutedChannels]); }
  isMuted(ch) { return this.mutedChannels.has(ch); }
  setSlowMode(ch, sec) { if (!this.mod.isAdmin) return; if (!this._slowMode) this._slowMode = {}; this._slowMode[ch] = sec; DB.setKey('slowMode', this._slowMode); for (const [pid] of this.peers) this.sendTo(pid, { type: 'slow-mode', channel: ch, seconds: sec }); }
  getSlowMode(ch) { return this._slowMode?.[ch]||0; }
  async setBroadcast(ch, on) { if (!this.mod.isAdmin) return; if (on) this.broadcastChannels.add(ch); else this.broadcastChannels.delete(ch); DB.setKey('broadcastChannels', [...this.broadcastChannels]); await this._emit('msg', { text: '📢 ' + ch + ' is now ' + (on?'broadcast-only':'open to all'), hops: 0 }, { channel: ch }); }
  isBroadcast(ch) { return this.broadcastChannels.has(ch); }
  canWrite(ch) { if (!this.isBroadcast(ch)) return true; return this.mod.isAdmin||this.mod.isMod; }
  getBadges(pid) { const b = []; if (this.mod.admins.has(pid)) b.push({ icon: '🛡️', label: 'Admin' }); if (this.mod.mods.has(pid)) b.push({ icon: '⚔️', label: 'Mod' }); const ha = Date.now()-3600000; if (this.state.getAll().filter(m => m.senderId===pid&&m.ts>ha).length>=10) b.push({ icon: '⚡', label: 'Active' }); const p = this.peers.get(pid); if (p&&Date.now()-(this.trust.firstSeen?.[pid]||p.seen)<3600000) b.push({ icon: '🆕', label: 'New' }); return b; }
  getProfile(pid) { if (pid===this.id) return { ...this.profile, name: this.name, id: this.id, online: true, lastSeen: Date.now(), posts: this.state.getUserPosts(this.id) }; const p = this.peerProfiles.get(pid)||{}; const peer = this.peers.get(pid); return { bio: p.bio||'', status: p.status||'offline', emoji: p.emoji||'', avatar: p.avatar||'', posts: this.state.getUserPosts(pid), name: peer?.info?.name||p.name||pid.slice(0,8), id: pid, online: !!peer, lastSeen: peer?.seen||p.lastSeen||0 }; }
  _getActiveStories() { return this.state.getActiveStories(); }
  requestHistory(uid, ch) { return this.state.getChannel(ch).filter(m => m.senderId===uid); }

  // ═══ DHT + HB ═══
  onDHTLook(d, from) { const c = this.rt.closest(d.target, CFG.K); this.sendTo(from, { type: 'dht-lookup-reply', lid: d.lid, target: d.target, nodes: c.map(n => ({ id: n.id, name: n.name })) }); }
  onDHTReply(d) { if (d.nodes) for (const n of d.nodes) this.rt.add(n); ui(); }
  doLookup(t) { const c = this.rt.closest(t, CFG.ALPHA); for (const n of c) if (this.peers.has(n.id)) this.sendTo(n.id, { type: 'dht-lookup', lid: crypto.randomUUID(), target: t }); }
  onHB(d, from) { const p = this.peers.get(from); if (p) p.seen = Date.now(); if (d.nodes) for (const n of d.nodes) this.rt.add(n); if (d.trust) this.trust.mergeTrust(d.trust, from); }
  startHB() { setInterval(() => { this.genesis.peerCount = this.peers.size; const s = this.snap().slice(0,15); const td = this.trust.getShareable(); for (const [pid] of this.peers) this.sendTo(pid, { type: 'heartbeat', nid: this.id, ts: Date.now(), nodes: s, trust: td }); for (const [pid, p] of this.peers) { if (Date.now()-p.seen>CFG.TIMEOUT) { this.rt.rm(pid); this.drop(pid); } } ui(); }, CFG.HB); }
  startRefresh() { setInterval(() => { const r = [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2,'0')).join(''); this.doLookup(r); }, CFG.REFRESH); }
  snap() { const n = []; for (const b of this.rt.bkts) for (const x of b) n.push({ id: x.id, name: x.name }); return n.slice(0,50); }
  sendTo(pid, d) { const p = this.peers.get(pid); if (p?.ch?.readyState==='open') try { p.ch.send(JSON.stringify(d)); } catch(_) {} }

  // ═══ RELAY ═══
  _canRelay() { if (this._relayCount>=5) return false; this._relayCount++; if (!this._relayResetTimer) { this._relayResetTimer = setTimeout(() => { this._relayCount = 0; this._relayResetTimer = null; }, 1000); } return true; }
  _onRelayRequest(d, from) { if (!d.targetId||!d.fromId||!this._canRelay()) return; if (this.peers.has(d.targetId)) this.sendTo(d.targetId, { type: 'signal-relay', signal: { type: 'relay-offer', fromId: d.fromId, fromName: d.fromName }, relayedBy: this.id }); }
  _onRelaySignal(d, from) { if (!d.signal) return; const sig = d.signal; if (sig.type==='relay-offer'&&sig.fromId) { if (!this.peers.has(sig.fromId)&&!this.pending.has(sig.fromId)) { this.relayPeers.set(sig.fromId, from); this.startConn(sig.fromId, sig.fromName||'peer'); } } else if (sig.sdp||sig.candidate) { const t = sig.targetId||sig.from; if (t) { if (this.peers.has(t)) this.sendTo(t, { type: 'signal-relay', signal: sig }); else this.onSig({ signal: sig, from: t, fromName: sig.fromName }); } } }
  sig(to, s) { if (this.ws?.readyState===WebSocket.OPEN) { this.ws.send(JSON.stringify({ type: 'signal', to, from: this.id, fromName: this.name, signal: s })); } else { const relay = this.relayPeers.get(to); if (relay&&this.peers.has(relay)) this.sendTo(relay, { type: 'signal-relay', signal: { ...s, targetId: to, from: this.id, fromName: this.name } }); else { for (const [pid] of this.peers) { this.sendTo(pid, { type: 'signal-relay', signal: { ...s, targetId: to, from: this.id, fromName: this.name } }); return; } } } }
}
