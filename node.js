// ═══════════════════════════════════════
// 7. MAIN NODE
// ═══════════════════════════════════════
class Node {
  constructor() {
    this.id = null; this.name = ''; this.ws = null;
    this.crypto = new CryptoId();
    this.rt = null; this.gossip = new Gossip(); this.store = new MsgStore();
    this.chMgr = new ChannelMgr(); this.clock = new LamportClock();
    this.peers = new Map(); this.pending = new Map();
    this.peerKeys = new Map(); // peerId -> { sign: jwk, dh: jwk }
    this.dmSecrets = new Map(); // peerId -> AES-GCM CryptoKey
    this.ice = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
    this.gCnt = 0;
    this.trust = new TrustEngine();
    this.mod = new ModerationEngine();
    this.ft = new FileTransfer();
    this.genesis = new NetworkGenesis();
    this.reactions = new Map(); // msgId -> { emoji: [senderId, ...] }
    this.blocked = new Set(); // blocked user IDs (local only)
    this.bookmarks = []; // [{ msgId, text, sender, ts }]
    this._lastMsgTime = new Map(); // senderId -> timestamp (anti-flood)
    this.mutedChannels = new Set(); // muted channel names (no notifications)
    this.pendingAdminQueue = []; // messages waiting for admin to come online
    // ── Social features (v21) ──
    this.profile = { bio: '', status: 'online', emoji: '', posts: [] }; // own profile
    this.peerProfiles = new Map(); // peerId -> { bio, status, emoji, posts }
    this.stories = new Map(); // oderId -> { text, bgColor, ts, expiresAt }
    this.typing = new Map(); // channel -> Map(peerId -> { name, ts })
    this.pins = {}; // channel -> [msgId, ...]
    this.broadcastChannels = new Set(); // channels in broadcast mode
    this.readReceipts = new Map(); // msgId -> { delivered: bool, read: bool }
  }

  async init(name) {
    this.name = name;
    await DB.open();
    await this.crypto.init();
    this.id = await this.crypto.nodeId();
    this.rt = new RT(this.id);

    // Save username
    await DB.setKey('username', name);

    // Clean up corrupt data from previous versions
    await DB.cleanupCorrupt();

    // Load persisted data
    await this.store.loadFromDB();
    await this.chMgr.loadFromDB();
    this.chMgr.cleanup();
    await this.trust.loadFromDB();
    await this.mod.loadFromDB();
    await this.genesis.loadFromDB();

    // Load personal data
    const blocked = await DB.getKey('blocked');
    if (Array.isArray(blocked)) for (const b of blocked) this.blocked.add(b);
    const bm = await DB.getKey('bookmarks');
    if (Array.isArray(bm)) this.bookmarks = bm;
    const sm = await DB.getKey('slowMode');
    if (sm && typeof sm === 'object') this._slowMode = sm;
    const dn = await DB.getKey('dmNames');
    if (dn && typeof dn === 'object') { this._dmNames = new Map(Object.entries(dn)); }
    const muted = await DB.getKey('mutedChannels');
    if (Array.isArray(muted)) for (const m of muted) this.mutedChannels.add(m);
    const paq = await DB.getKey('pending:adminQueue');
    if (Array.isArray(paq)) this.pendingAdminQueue = paq;
    this._pruneAdminQueue();

    // Load social profile
    const prof = await DB.getKey('profile');
    if (prof && typeof prof === 'object') Object.assign(this.profile, prof);
    const pins = await DB.getKey('pins');
    if (pins && typeof pins === 'object') this.pins = pins;
    const bc = await DB.getKey('broadcastChannels');
    if (Array.isArray(bc)) for (const c of bc) this.broadcastChannels.add(c);
    const savedStories = await DB.getKey('stories');
    if (Array.isArray(savedStories)) {
      const now = Date.now();
      for (const s of savedStories) {
        if (s.expiresAt > now) this.stories.set(s.senderId + '-' + s.ts, s);
      }
    }

    // Don't auto-assign admin here — wait for bootstrap peer list
    this.mod.checkAdmin(this.id);

    // Restore Lamport clock from stored messages
    for (const m of this.store.getAll()) {
      if (m.lamport > this.clock.time) this.clock.time = m.lamport;
      this.gossip.mark(m.msgId);
    }

    this._sessionStart = Date.now();
    this._setStatus('reconnecting');
    this.connectBS();
    this.startHB();
    this.startRefresh();
    this.startWakeDetection();

    const displayId = `${name}#${this.crypto.shortId}`;
    sys(`🔑 ${displayId}${this.mod.isAdmin ? ' · 🛡️ Admin' : ''}`);

    // Update identity badge
    document.getElementById('idBadge').textContent = displayId;
    document.getElementById('idBadge').title = `Public key: ${this.crypto.pubKeyHex.slice(0, 32)}…`;

    // Render stored messages for current channel
    renderChannel();
    refreshChannelList();
  }

  // ── Bootstrap with aggressive reconnect ──
  connectBS() {
    if (this._wsConnecting) return;
    this._wsConnecting = true;
    try { this.ws?.close(); } catch (_) {}

    this.ws = new WebSocket(BOOTSTRAP);
    this.ws.onopen = () => {
      this._wsConnecting = false;
      this._wsRetry = 1;
      this._bsFailed = false;
      this._setStatus('connected');
      console.log('Bootstrap connected');
      this.ws.send(JSON.stringify({ type: 'register', nodeId: this.id, username: this.name }));
    };
    this.ws.onmessage = (e) => { try { this.onBS(JSON.parse(e.data)); } catch (er) { console.error('WS:', er); } };
    this.ws.onclose = () => {
      this._wsConnecting = false;
      this._setStatus('disconnected');
      const delay = Math.min((this._wsRetry || 1) * 1000, 10000);
      this._wsRetry = Math.min((this._wsRetry || 1) * 2, 10);
      console.log(`Bootstrap lost, retry in ${delay}ms`);

      // If bootstrap fails repeatedly, try peer cache
      if (!this._bsFailed) {
        this._bsFailed = true;
        this._tryPeerCache();
      }

      setTimeout(() => this.connectBS(), delay);
    };
    this.ws.onerror = () => { this._wsConnecting = false; };
  }

  // ── Peer cache: reconnect without bootstrap ──
  async _tryPeerCache() {
    try {
      const cached = await DB.getPeers();
      if (!cached || !cached.length) return;

      // Sort by most recently seen
      cached.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      const candidates = cached.slice(0, 5);
      console.log(`Bootstrap down — trying ${candidates.length} cached peer(s)`);

      for (const p of candidates) {
        if (p.id === this.id || this.peers.has(p.id) || this.pending.has(p.id)) continue;
        // We can't initiate WebRTC without signaling, but if we have ANY connected peer,
        // ask them to relay our signaling to the cached peer
        if (this.peers.size > 0) {
          this._requestPeerRelay(p.id, p.name);
        }
      }

      // Also: if we have connected peers, we're still alive even without bootstrap
      if (this.peers.size > 0) {
        this._setStatus('connected');
        console.log(`Still connected to ${this.peers.size} peer(s) without bootstrap`);
      }
    } catch (e) {
      console.error('Peer cache error:', e);
    }
  }

  // Ask a connected peer to relay signaling to a target peer
  _requestPeerRelay(targetId, targetName) {
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'signal-relay-request', targetId, targetName, fromId: this.id, fromName: this.name });
      console.log(`Requested relay to ${targetName || targetId.slice(0, 8)} via ${pid.slice(0, 8)}`);
      return; // Ask one peer only
    }
  }

  // Full reconnect — drop all dead peers, reconnect bootstrap, re-establish P2P
  reconnect() {
    this._setStatus('reconnecting');
    console.log('Reconnecting...');
    for (const [pid] of this.peers) this.drop(pid);
    for (const [pid] of this.pending) {
      try { this.pending.get(pid)?.pc?.close(); } catch (_) {}
    }
    this.pending.clear();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectBS();
    } else {
      this.ws.send(JSON.stringify({ type: 'register', nodeId: this.id, username: this.name }));
    }
    ui();
  }

  // Status indicator — updates the tag badge color
  _setStatus(s) {
    this._status = s;
    const tag = document.getElementById('statusTag');
    if (!tag) return;
    tag.textContent = 'v1.1';
    if (s === 'connected') tag.className = 'tag tag-on';
    else if (s === 'reconnecting') tag.className = 'tag tag-warn';
    else tag.className = 'tag tag-off';
  }

  // Start visibility/wake listeners
  startWakeDetection() {
    // Page Visibility API — fires when user switches back to tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Small delay to let network stack wake up
        setTimeout(() => this._checkAndReconnect(), 500);
      }
    });

    // Also detect wake via timer drift
    // If our interval fires much later than expected, device was sleeping
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick;
      lastTick = now;
      // If more than 8s drift (expected 3s interval), we were asleep
      if (drift > 8000) {
        console.log(`Wake detected: ${drift}ms drift`);
        setTimeout(() => this._checkAndReconnect(), 500);
      }
    }, 3000);

    // Online/offline events
    window.addEventListener('online', () => {
      console.log('Network restored');
      setTimeout(() => this._checkAndReconnect(), 1000);
    });
  }

  _checkAndReconnect() {
    // Check if bootstrap WebSocket is dead
    const wsAlive = this.ws && this.ws.readyState === WebSocket.OPEN;
    // Check if any peers are still alive
    const peersAlive = [...this.peers.values()].some(p => {
      try { return p.ch?.readyState === 'open'; } catch (_) { return false; }
    });

    if (!wsAlive || !peersAlive) {
      this.reconnect();
    } else {
      // WS is open but peers might be stale — send a ping via re-register
      // to get fresh peer list and reconnect to any new peers
      try {
        this.ws.send(JSON.stringify({ type: 'register', nodeId: this.id, username: this.name }));
      } catch (_) {
        this.reconnect();
      }
    }
  }

  onBS(m) {
    if (m.type === 'peers') this.onList(m.peers || []);
    else if (m.type === 'signal') this.onSig(m);
    else if (m.type === 'peer-joined') this.onJoin(m);
    else if (m.type === 'peer-left') this.onLeave(m);
  }

  async onList(data) {
    // Server may send { type:'peers', peers:[], cachedGenesis:{} }
    const list = Array.isArray(data) ? data : (data.peers || []);
    const others = list.filter(p => p.nodeId !== this.id);
    console.log(`Found ${others.length} peer(s)`);
    for (const p of others) this.rt.add({ id: p.nodeId, name: p.username });

    // Genesis logic
    if (!this.genesis.networkId && others.length === 0) {
      // No one else online, no cached genesis → we found a new network
      if (data.cachedGenesis && data.cachedGenesis.networkId) {
        // Server has a cached genesis from before — adopt it
        await this.genesis.adopt(data.cachedGenesis);
        if (Array.isArray(data.cachedGenesis.admins)) {
          this.mod.admins = new Set(data.cachedGenesis.admins);
          DB.setKey('mod:admins', data.cachedGenesis.admins);
        }
        this.mod.checkAdmin(this.id);
        console.log(`Reconnected to network (admin: ${this.genesis.adminName || '?'})`);
      } else {
        // Truly first peer ever → create genesis
        await this.genesis.create(this.id, this.name, this.crypto);
        this.mod.admins = new Set([this.id]);
        this.mod.checkAdmin(this.id);
        DB.setKey('mod:admins', [this.id]);
        sys('🛡️ Network founded — you are admin');
        // Cache genesis on server for persistence
        this._sendToServer({ type: 'genesis-update', genesis: { ...this.genesis.toPacket(), admins: [...this.mod.admins] } });
      }
    } else if (!this.genesis.networkId && others.length > 0) {
      // Peers exist but we have no genesis — we'll get it via handshake
      if (data.cachedGenesis && data.cachedGenesis.networkId) {
        await this.genesis.adopt(data.cachedGenesis);
        if (Array.isArray(data.cachedGenesis.admins)) {
          this.mod.admins = new Set(data.cachedGenesis.admins);
          DB.setKey('mod:admins', data.cachedGenesis.admins);
        }
        this.mod.checkAdmin(this.id);
      }
    }

    this.genesis.peerCount = this.peers.size;

    const tgts = this.rt.closest(this.id, CFG.MAX_PEERS);
    for (const t of tgts) {
      if (!this.peers.has(t.id) && !this.pending.has(t.id) && this.id < t.id)
        this.startConn(t.id, t.name);
    }
    this._setStatus('connected');
    ui();
  }

  // Send data to bootstrap server via WebSocket
  _sendToServer(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(data)); } catch (e) { console.error('Server send:', e); }
    }
  }

  // ── REACTIONS ──
  sendReaction(msgId, emoji) {
    if (!msgId || !emoji) return;
    // Toggle locally
    if (!this.reactions.has(msgId)) this.reactions.set(msgId, {});
    const map = this.reactions.get(msgId);
    if (!map[emoji]) map[emoji] = [];
    const idx = map[emoji].indexOf(this.id);
    if (idx >= 0) map[emoji].splice(idx, 1); // Remove (toggle off)
    else map[emoji].push(this.id);            // Add (toggle on)
    // Clean empty
    if (map[emoji].length === 0) delete map[emoji];

    // Broadcast
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'reaction', msgId, emoji, senderId: this.id, toggle: idx < 0 });
    }
    renderChannel();
  }

  onReaction(d, from) {
    if (!d.msgId || !d.emoji || !d.senderId) return;
    if (!this.reactions.has(d.msgId)) this.reactions.set(d.msgId, {});
    const map = this.reactions.get(d.msgId);
    if (!map[d.emoji]) map[d.emoji] = [];
    const idx = map[d.emoji].indexOf(d.senderId);
    if (d.toggle && idx < 0) map[d.emoji].push(d.senderId);
    else if (!d.toggle && idx >= 0) map[d.emoji].splice(idx, 1);
    if (map[d.emoji].length === 0) delete map[d.emoji];
    // Forward
    const fwd = { ...d, hops: (d.hops || 0) + 1 };
    if ((fwd.hops || 0) < 3) {
      const tgts = this.gossip.pick([...this.peers.values()].map(p => p.info), [from, d.senderId]);
      for (const t of tgts) this.sendTo(t.id, fwd);
    }
    scheduleRender();
  }

  // ── DELETE / EDIT MESSAGES ──
  async deleteMessage(msgId) {
    // Only delete own messages
    const all = this.store.getAll();
    const msg = all.find(m => m.msgId === msgId);
    if (!msg || msg.senderId !== this.id) return;
    this.store.deleteMsg(msgId);
    // Broadcast delete (signed so others trust it)
    const d = { type: 'delete-msg', msgId, senderId: this.id, ts: Date.now() };
    d.sig = await this.crypto.sign(d);
    for (const [pid] of this.peers) this.sendTo(pid, d);
    scheduleRender();
  }

  onDeleteMsg(d, from) {
    if (!d.msgId || !d.senderId) return;
    // Verify sender owns the message
    const msg = this.store.getAll().find(m => m.msgId === d.msgId);
    if (msg && msg.senderId === d.senderId) {
      this.store.deleteMsg(d.msgId);
      this.reactions.delete(d.msgId);
      // Forward
      const fwd = { ...d, hops: (d.hops || 0) + 1 };
      if ((fwd.hops || 0) < CFG.TTL) {
        for (const [pid] of this.peers) { if (pid !== from) this.sendTo(pid, fwd); }
      }
      renderChannel();
    }
  }

  async editMessage(msgId, newText) {
    const all = this.store.getAll();
    const msg = all.find(m => m.msgId === msgId);
    if (!msg || msg.senderId !== this.id) return;
    msg.text = newText;
    msg._edited = true;
    DB.saveMsg(msg);
    const d = { type: 'edit-msg', msgId, senderId: this.id, newText, ts: Date.now() };
    d.sig = await this.crypto.sign(d);
    for (const [pid] of this.peers) this.sendTo(pid, d);
    scheduleRender();
  }

  async forwardMessage(msgId, targetChannel) {
    const msg = this.store.getAll().find(m => m.msgId === msgId);
    if (!msg) return;
    const fwdText = `↗ ${msg.sender}: ${msg.text}`;
    this.chMgr.switchTo(targetChannel);
    this.chMgr.current = targetChannel;
    await this.sendChat(fwdText);
    scheduleRender();
    refreshChannelList();
  }

  // ── BLOCK / UNBLOCK ──
  blockUser(userId) {
    this.blocked.add(userId);
    DB.setKey('blocked', [...this.blocked]);
  }

  unblockUser(userId) {
    this.blocked.delete(userId);
    DB.setKey('blocked', [...this.blocked]);
  }

  isBlocked(userId) { return this.blocked.has(userId); }

  // ── BOOKMARKS ──
  addBookmark(msgId) {
    const msg = this.store.getAll().find(m => m.msgId === msgId);
    if (!msg || this.bookmarks.some(b => b.msgId === msgId)) return;
    this.bookmarks.push({ msgId, text: msg.text, sender: msg.sender, channel: msg.channel, ts: msg.ts });
    if (this.bookmarks.length > 50) this.bookmarks.shift();
    DB.setKey('bookmarks', this.bookmarks);
  }

  removeBookmark(msgId) {
    this.bookmarks = this.bookmarks.filter(b => b.msgId !== msgId);
    DB.setKey('bookmarks', this.bookmarks);
  }

  // ── MUTE/UNMUTE CHANNELS ──
  muteChannel(ch) { this.mutedChannels.add(ch); DB.setKey('mutedChannels', [...this.mutedChannels]); }
  unmuteChannel(ch) { this.mutedChannels.delete(ch); DB.setKey('mutedChannels', [...this.mutedChannels]); }
  isMuted(ch) { return this.mutedChannels.has(ch); }

  // ── POLL SYSTEM ──
  sendPoll(question, options) {
    const ch = this.chMgr.current;
    const pollId = `poll-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const lamport = this.clock.tick();
    const msgId = `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const d = {
      type: 'chat', msgId, sender: this.name, senderId: this.id,
      text: `📊 ${question}`, ts: Date.now(), hops: 0, channel: ch, lamport,
      poll: { id: pollId, question, options: options.map(o => ({ text: o, votes: [] })) },
    };
    this.gossip.mark(msgId);
    this.store.add({ ...d, _verified: true });
    showMsg({ sender: this.name, senderId: this.id, text: d.text, time: d.ts, route: 'self', hops: 0, self: true, channel: ch, verified: true, msgId, poll: d.poll });
    for (const [pid] of this.peers) this.sendTo(pid, d);
    refreshChannelList();
  }

  votePoll(msgId, optIdx) {
    const msg = this.store.getAll().find(m => m.msgId === msgId);
    if (!msg?.poll) return;
    for (const opt of msg.poll.options) { opt.votes = opt.votes.filter(v => v !== this.id); }
    if (msg.poll.options[optIdx]) { msg.poll.options[optIdx].votes.push(this.id); }
    DB.saveMsg(msg);
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'poll-vote', msgId, optIdx, voterId: this.id, hops: 0 });
    }
    renderChannel();
  }

  onPollVote(d, from) {
    if (!d.msgId || d.optIdx === undefined || !d.voterId) return;
    const msg = this.store.getAll().find(m => m.msgId === d.msgId);
    if (!msg?.poll) return;
    for (const opt of msg.poll.options) { opt.votes = opt.votes.filter(v => v !== d.voterId); }
    if (msg.poll.options[d.optIdx]) { msg.poll.options[d.optIdx].votes.push(d.voterId); }
    DB.saveMsg(msg);
    // Forward
    const fwd = { ...d, hops: (d.hops || 0) + 1 };
    if (fwd.hops < 3) { for (const [pid] of this.peers) { if (pid !== from) this.sendTo(pid, fwd); } }
    renderChannel();
  }

  // ── SLOW MODE (admin sets per-channel delay in seconds) ──
  setSlowMode(channel, seconds) {
    if (!this.mod.isAdmin) return;
    if (!this._slowMode) this._slowMode = {};
    this._slowMode[channel] = seconds;
    DB.setKey('slowMode', this._slowMode);
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'slow-mode', channel, seconds });
    }
  }

  getSlowMode(channel) {
    return this._slowMode?.[channel] || 0;
  }

  onEditMsg(d, from) {
    if (!d.msgId || !d.senderId || !d.newText) return;
    const msg = this.store.getAll().find(m => m.msgId === d.msgId);
    if (msg && msg.senderId === d.senderId) {
      msg.text = d.newText;
      msg._edited = true;
      DB.saveMsg(msg);
      const fwd = { ...d, hops: (d.hops || 0) + 1 };
      if ((fwd.hops || 0) < CFG.TTL) {
        for (const [pid] of this.peers) { if (pid !== from) this.sendTo(pid, fwd); }
      }
      scheduleRender();
    }
  }

  // ── PIN MESSAGES ──
  onJoin(m) {
    if (m.nodeId === this.id) return;
    this.rt.add({ id: m.nodeId, name: m.username });
    if (this.peers.size < CFG.MAX_PEERS && !this.peers.has(m.nodeId) && !this.pending.has(m.nodeId)) {
      if (this.id < m.nodeId) this.startConn(m.nodeId, m.username);
    }
    console.log(`${m.username} joined`);
    ui();
  }

  onLeave(m) { this.rt.rm(m.nodeId); this.drop(m.nodeId); console.log('Peer left'); ui(); }

  // ── WebRTC ──
  startConn(tid, tn) {
    if (this.peers.has(tid) || this.pending.has(tid)) return;
    const pc = new RTCPeerConnection(this.ice);
    this.pending.set(tid, { pc, name: tn, role: 'init' });
    const ch = pc.createDataChannel('mesh', { ordered: true });
    this.wireCh(ch, tid, tn);
    pc.onicecandidate = (e) => { if (e.candidate) this.sig(tid, { type: 'candidate', candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { this.pending.delete(tid); this.drop(tid); } };
    pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => this.sig(tid, { type: 'offer', sdp: pc.localDescription })).catch(e => { console.error('Offer:', e); this.pending.delete(tid); });
  }

  onSig(m) {
    const { from, fromName, signal } = m; if (from === this.id) return;
    if (signal.type === 'offer') {
      if (this.peers.has(from) || this.pending.has(from)) return;
      const pc = new RTCPeerConnection(this.ice);
      this.pending.set(from, { pc, name: fromName, role: 'resp' });
      pc.ondatachannel = (e) => this.wireCh(e.channel, from, fromName);
      pc.onicecandidate = (e) => { if (e.candidate) this.sig(from, { type: 'candidate', candidate: e.candidate }); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { this.pending.delete(from); this.drop(from); } };
      pc.setRemoteDescription(signal.sdp).then(() => pc.createAnswer()).then(a => pc.setLocalDescription(a)).then(() => this.sig(from, { type: 'answer', sdp: pc.localDescription })).catch(e => { console.error('Answer:', e); this.pending.delete(from); });
    } else if (signal.type === 'answer') {
      const p = this.pending.get(from);
      if (p?.pc && p.role === 'init' && p.pc.signalingState === 'have-local-offer') p.pc.setRemoteDescription(signal.sdp).catch(e => console.error('SRD:', e));
    } else if (signal.type === 'candidate') {
      const t = this.pending.get(from) || this.peers.get(from);
      if (t?.pc) t.pc.addIceCandidate(signal.candidate).catch(e => console.error('ICE:', e));
    }
  }

  async wireCh(ch, pid, pn) {
    ch.onopen = async () => {
      const p = this.pending.get(pid); const pc = p?.pc; this.pending.delete(pid);
      this.peers.set(pid, { pc, ch, info: { id: pid, name: pn }, seen: Date.now() });

      // Send crypto handshake — keys, routing, genesis, moderation data
      const pubKeys = await this.crypto.exportPublic();
      this.genesis.peerCount = this.peers.size;
      this.sendTo(pid, {
        type: 'handshake',
        nodeId: this.id,
        username: this.name,
        keys: pubKeys,
        nodes: this.snap(),
        genesis: this.genesis.toPacket(),
        bannedWords: this.mod.getBannedWordsPacket(),
        admins: [...this.mod.admins],
        mods: [...this.mod.mods],
        ads: this.mod.getAdsPacket(),
        mediaApprovals: [...this.mod.approvedMedia].slice(-200),
        mediaRejections: [...this.mod.rejectedMedia].slice(-200),
        slowMode: this._slowMode || {},
        // Social data (v21)
        profile: { bio: this.profile.bio, status: this.profile.status, emoji: this.profile.emoji, posts: (this.profile.posts || []).slice(-200) },
        pins: this.pins,
        broadcastChannels: [...this.broadcastChannels],
        stories: this._getActiveStories(),
      });

      // Send history for sync
      const history = this.store.getAll().filter(m => !this.chMgr.isDM(m.channel));
      if (history.length) this.sendTo(pid, { type: 'history-sync', messages: history });

      // If this peer is admin/mod, flush our pending queue to them
      // (small delay so their handshake arrives first and they know they're admin)
      setTimeout(() => this._flushToAdmin(pid), 300);

      // Persist peer info
      DB.savePeer({ id: pid, name: pn, lastSeen: Date.now() });
      this.trust.onConnect(pid);

      console.log(`Connected to ${pn}`);
      ui();
    };
    ch.onmessage = (e) => { try { this.onPeerMsg(pid, JSON.parse(e.data)); } catch (er) { console.error('Parse:', er); } };
    ch.onclose = () => { this.drop(pid); ui(); };
  }

  drop(id) {
    this.trust.onDisconnect(id);
    const p = this.peers.get(id);
    if (p) { try { p.ch?.close(); } catch (_) { } try { p.pc?.close(); } catch (_) { } }
    this.peers.delete(id); this.pending.delete(id);
  }

  // ── Peer messages ──
  onPeerMsg(from, d) {
    const p = this.peers.get(from); if (p) p.seen = Date.now();
    switch (d.type) {
      case 'chat': this.onChat(d, from); break;
      case 'dm': this.onDM(d, from); break;
      case 'handshake': this.onHandshake(d, from); break;
      case 'dht-lookup': this.onDHTLook(d, from); break;
      case 'dht-lookup-reply': this.onDHTReply(d); break;
      case 'heartbeat': this.onHB(d, from); break;
      case 'history-sync': this.onHistSync(d); break;
      case 'ban-vote': this.onBanVote(d, from); break;
      case 'mod-report': this.onModReport(d, from); break;
      case 'mod-action': this.onModAction(d, from); break;
      case 'mod-media': this.onModMedia(d, from); break;
      case 'mod-banwords': this.onBanWords(d, from); break;
      case 'file-meta': this.onFileMeta(d, from); break;
      case 'file-chunk': this.onFileChunk(d, from); break;
      case 'mod-roles': this.onModRoles(d); break;
      case 'mod-ads': this.onModAds(d, from); break;
      case 'reaction': this.onReaction(d, from); break;
      case 'delete-msg': this.onDeleteMsg(d, from); break;
      case 'edit-msg': this.onEditMsg(d, from); break;
      case 'slow-mode': if (d.channel && d.seconds !== undefined) { if (!this._slowMode) this._slowMode = {}; this._slowMode[d.channel] = d.seconds; DB.setKey('slowMode', this._slowMode); } break;
      case 'poll-vote': this.onPollVote(d, from); break;
      // Social features (v21)
      case 'typing': this.onTyping(d, from); break;
      case 'msg-ack': this.onMsgAck(d, from); break;
      case 'msg-read': this.onMsgRead(d, from); break;
      case 'story': this.onStory(d, from); break;
      case 'profile-update': this.onProfileUpdate(d, from); break;
      case 'pin': this.onPin(d, from); break;
      case 'social-post': this.onSocialPost(d, from); break;
      case 'signal-relay-request': this._onRelayRequest(d, from); break;
      case 'signal-relay': this._onRelaySignal(d, from); break;
    }
  }

  // ── Handshake — receive keys + resolve network genesis conflicts ──
  async onHandshake(d, from) {
    if (d.keys) {
      this.peerKeys.set(d.nodeId || from, d.keys);
      try {
        const secret = await this.crypto.deriveShared(d.keys.dh);
        this.dmSecrets.set(d.nodeId || from, secret);
      } catch (e) { console.error('ECDH derive error:', e); }
    }
    if (d.nodes) for (const n of d.nodes) this.rt.add(n);

    // ── GENESIS CONFLICT RESOLUTION ──
    if (d.genesis && d.genesis.networkId) {
      if (!this.genesis.networkId) {
        // We have no network yet — adopt theirs
        await this.genesis.adopt(d.genesis);
        this._adoptNetworkData(d);
        console.log(`Joined network (admin: ${d.genesis.adminName || d.genesis.adminId?.slice(0, 8)})`);
      } else if (this.genesis.networkId !== d.genesis.networkId) {
        // CONFLICT: two different networks meeting
        const ourPeers = this.peers.size;
        const theirPeers = d.genesis.peerCount || 0;
        const decision = this.genesis.compare(d.genesis, ourPeers, theirPeers);

        if (decision === 'adopt') {
          // Their network wins — adopt their genesis and rules
          await this.genesis.adopt(d.genesis);
          this._adoptNetworkData(d);
          console.log(`Network merged — adopting (admin: ${d.genesis.adminName || '?'})`);
        } else {
          // Our network wins — they will adopt ours during their handshake
          console.log(`Genesis conflict: we win (our peers: ${ourPeers}, theirs: ${theirPeers})`);
        }
      } else {
        // Same network — just merge moderation data normally
        if (d.bannedWords) this.mod.mergeBannedWords(d.bannedWords);
        if (Array.isArray(d.ads) && d.ads.length) this.mod.customAds = d.ads;
      }
    } else {
      if (d.bannedWords) this.mod.mergeBannedWords(d.bannedWords);
    }

    this.mod.checkAdmin(this.id);
    const peer = this.peers.get(from);
    if (peer && d.username) peer.info.name = d.username;

    // Merge media approval/rejection state (prevents stale "pending" on reconnect)
    if (Array.isArray(d.mediaApprovals)) {
      for (const mid of d.mediaApprovals) this.mod.approvedMedia.add(mid);
      DB.setKey('mod:approved', [...this.mod.approvedMedia]);
    }
    if (Array.isArray(d.mediaRejections)) {
      for (const mid of d.mediaRejections) this.mod.rejectedMedia.add(mid);
      DB.setKey('mod:rejected', [...this.mod.rejectedMedia]);
    }

    // Merge slow mode settings
    if (d.slowMode && typeof d.slowMode === 'object') {
      if (!this._slowMode) this._slowMode = {};
      for (const [ch, sec] of Object.entries(d.slowMode)) {
        if (typeof sec === 'number') this._slowMode[ch] = sec;
      }
      DB.setKey('slowMode', this._slowMode);
    }

    // Merge social data (v21)
    const senderId = d.nodeId || from;
    if (d.profile) {
      this.peerProfiles.set(senderId, { ...d.profile, lastSeen: Date.now() });
    }
    if (d.pins && typeof d.pins === 'object') {
      for (const [ch, pns] of Object.entries(d.pins)) {
        if (Array.isArray(pns)) this.pins[ch] = pns.slice(0, 3);
      }
      DB.setKey('pins', this.pins);
    }
    if (Array.isArray(d.broadcastChannels)) {
      for (const c of d.broadcastChannels) this.broadcastChannels.add(c);
      DB.setKey('broadcastChannels', [...this.broadcastChannels]);
    }
    if (Array.isArray(d.stories)) {
      for (const s of d.stories) {
        if (s.senderId && s.ts && s.expiresAt > Date.now()) {
          this.stories.set(s.senderId + '-' + s.ts, s);
        }
      }
    }

    // If this peer is admin/mod, flush our pending admin queue to them
    if (this.mod.admins.has(senderId) || this.mod.mods.has(senderId)) {
      this._flushToAdmin(from);
    }

    ui();
  }

  // Adopt network data when we lose genesis conflict or join existing network
  _adoptNetworkData(d) {
    // Admin list from winning network replaces ours
    if (Array.isArray(d.admins)) {
      this.mod.admins = new Set(d.admins);
      DB.setKey('mod:admins', d.admins);
    }
    if (Array.isArray(d.mods)) {
      this.mod.mods = new Set(d.mods);
      DB.setKey('mod:mods', d.mods);
    }
    if (d.bannedWords) this.mod.mergeBannedWords(d.bannedWords);
    if (Array.isArray(d.ads)) {
      this.mod.customAds = d.ads;
      DB.setKey('mod:ads', d.ads);
    }
    this.mod.checkAdmin(this.id);
  }

  // ── Chat (public channels) ──
  async onChat(d, from) {
    if (this.gossip.has(d.msgId)) return;
    this.gossip.mark(d.msgId);
    if (d.hops >= CFG.TTL) return;

    // Block check — silently drop messages from blocked users
    if (this.blocked.has(d.senderId)) return;

    // Anti-flood: drop if same sender sent less than 500ms ago
    const lastTime = this._lastMsgTime.get(d.senderId) || 0;
    if (Date.now() - lastTime < 500) return;
    this._lastMsgTime.set(d.senderId, Date.now());

    // Trust gate
    if (!this.trust.shouldAccept(d.senderId)) {
      console.log(`Dropped msg from ${d.senderId.slice(0,8)} (rate limited or banned)`);
      return;
    }

    // Verify signature if we have peer's key
    let verified = false;
    const peerKey = this.peerKeys.get(d.senderId);
    if (peerKey && d.sig) {
      const { sig, ...payload } = d;
      verified = await this.crypto.verify(payload, sig, peerKey.sign);
    }

    // Trust scoring based on verification
    if (verified) {
      this.trust.onMessageReceived(d.senderId);
      // Credit the relay peer too (if different from sender)
      if (from !== d.senderId) this.trust.onRelay(from);
    } else if (peerKey && d.sig) {
      // Had key + sig but verification failed — suspicious
      this.trust.onViolation(d.senderId);
    }

    this.clock.update(d.lamport || 0);
    d._verified = verified;
    this.store.add(d);

    // AI pre-filter: scan incoming message for risk patterns
    const scan = this.mod.scanText(d.text);
    if (scan.flagged) {
      // Auto-report silently to admin
      const ctx = this.store.getChannel(d.channel || 'general');
      const report = this.mod.createReport(d, ctx, this.id, { auto: true, reason: scan.reason });
      this.mod.addReport(report);
      // Broadcast report to admin peers
      this._sendToAdmins({ type: 'mod-report', report });
      console.log(`Auto-flagged message from ${d.sender}`);
    }

    const ch = d.channel || 'general';
    this.chMgr.joined.add(ch);

    if (ch === this.chMgr.current) {
      const route = d.hops === 0 ? 'direct' : d.hops <= 2 ? 'gossip' : 'dht';
      showMsg({ sender: d.sender, senderId: d.senderId, text: d.text, time: d.ts, route, hops: d.hops, self: false, channel: ch, verified, msgId: d.msgId, replyTo: d.replyTo, fileMeta: d.fileMeta });
    } else {
      // Toast for messages in other channels (unless muted)
      if (!this.mutedChannels.has(ch)) {
        const isMention = d.text && (d.text.includes(`@${this.name}`) || d.text.includes(`@${this.crypto.shortId}`));
        showToast(d.sender, d.text, isMention ? 'mention' : 'chat', ch);
      }
    }

    // Gossip forward
    const fwd = { ...d }; delete fwd._verified; fwd.hops = d.hops + 1;
    const tgts = this.gossip.pick([...this.peers.values()].map(p => p.info), [from, d.senderId]);
    for (const t of tgts) this.sendTo(t.id, fwd);

    this.gCnt++; refreshChannelList(); stats();
  }

  async sendChat(text, replyTo = null) {
    const ch = this.chMgr.current;

    // Slow mode check
    const slowSec = this.getSlowMode(ch);
    if (slowSec > 0 && !this.mod.isAdmin && !this.mod.isMod) {
      const lastSent = this._lastSentTime?.[ch] || 0;
      if (Date.now() - lastSent < slowSec * 1000) {
        sys(`⏳ Slow mode: wait ${Math.ceil((slowSec * 1000 - (Date.now() - lastSent)) / 1000)}s`);
        return;
      }
    }
    if (!this._lastSentTime) this._lastSentTime = {};
    this._lastSentTime[ch] = Date.now();

    // If DM channel, send encrypted
    if (this.chMgr.isDM(ch)) {
      await this.sendDM(text, ch, replyTo);
      return;
    }

    const lamport = this.clock.tick();
    const msgId = `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const d = { type: 'chat', msgId, sender: this.name, senderId: this.id, text, ts: Date.now(), hops: 0, channel: ch, lamport };
    if (replyTo) d.replyTo = replyTo; // { msgId, sender, text }

    // Scan own outgoing message
    const scan = this.mod.scanText(text);
    if (scan.flagged) {
      const ctx = this.store.getChannel(ch);
      const report = this.mod.createReport(d, ctx, this.id, { auto: true, reason: 'outgoing: ' + scan.reason });
      this.mod.addReport(report);
      this._sendToAdmins({ type: 'mod-report', report });
    }

    d.sig = await this.crypto.sign(d);
    this.gossip.mark(msgId);
    this.store.add({ ...d, _verified: true });
    showMsg({ sender: this.name, senderId: this.id, text, time: d.ts, route: 'self', hops: 0, self: true, channel: ch, verified: true, msgId, replyTo });

    for (const [pid] of this.peers) this.sendTo(pid, d);
    refreshChannelList(); stats();
  }

  // ── DM (encrypted private messages) ──
  async sendDM(text, dmChannel, replyTo = null) {
    // Find peer ID from DM channel name
    const parts = dmChannel.replace('dm:', '').split('-');
    let peerId = null;
    for (const [id] of this.peers) {
      if (parts.includes(id.slice(0, 8))) { peerId = id; break; }
    }
    // Also check dmSecrets
    if (!peerId) {
      for (const [id] of this.dmSecrets) {
        if (parts.includes(id.slice(0, 8))) { peerId = id; break; }
      }
    }

    const secret = peerId ? this.dmSecrets.get(peerId) : null;
    if (!secret) { sys('⚠ No encryption key for this DM. Connect to peer first.'); return; }

    // Scan outgoing DM
    const scan = this.mod.scanText(text);
    if (scan.flagged) {
      const ctx = this.store.getChannel(dmChannel);
      const report = this.mod.createReport(
        { msgId: '', sender: this.name, senderId: this.id, text, channel: dmChannel, ts: Date.now() },
        ctx, this.id, { auto: true, isDM: true, reason: 'outgoing DM: ' + scan.reason }
      );
      this.mod.addReport(report);
      this._sendToAdmins({ type: 'mod-report', report });
    }

    const encrypted = await this.crypto.encrypt(text, secret);
    const lamport = this.clock.tick();
    const msgId = `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const d = {
      type: 'dm', msgId, sender: this.name, senderId: this.id,
      ts: Date.now(), hops: 0, channel: dmChannel, lamport,
      targetId: peerId, encrypted,
    };
    d.sig = await this.crypto.sign({ msgId: d.msgId, sender: d.sender, senderId: d.senderId, ts: d.ts, channel: d.channel, lamport: d.lamport, targetId: d.targetId });

    this.gossip.mark(msgId);
    // Store plaintext locally
    this.store.add({ ...d, text, _verified: true });
    showMsg({ sender: this.name, senderId: this.id, text, time: d.ts, route: 'e2e', hops: 0, self: true, channel: dmChannel, verified: true, dm: true });

    // Send to target directly if connected, otherwise gossip
    if (this.peers.has(peerId)) {
      this.sendTo(peerId, d);
    } else {
      for (const [pid] of this.peers) this.sendTo(pid, d);
    }
    refreshChannelList(); stats();
  }

  async onDM(d, from) {
    if (this.gossip.has(d.msgId)) return;
    this.gossip.mark(d.msgId);
    if (d.hops >= CFG.TTL) return;

    // If this DM is for us, decrypt it
    if (d.targetId === this.id) {
      const secret = this.dmSecrets.get(d.senderId);
      if (secret && d.encrypted) {
        const text = await this.crypto.decrypt(d.encrypted.iv, d.encrypted.ct, secret);
        this.clock.update(d.lamport || 0);

        // AI scan DM content after decryption
        const scan = this.mod.scanText(text);
        if (scan.flagged) {
          const ctx = this.store.getChannel(d.channel || '');
          const report = this.mod.createReport(
            { ...d, text }, ctx, this.id,
            { auto: true, isDM: true, reason: scan.reason }
          );
          this.mod.addReport(report);
          this._sendToAdmins({ type: 'mod-report', report });
        }

        const ch = d.channel || this.chMgr.dmChannel(this.id, d.senderId);
        this.chMgr.joined.add(ch);
        this.store.add({ ...d, text, _verified: true });

        // Send delivery acknowledgment
        this.sendAck(d.msgId, from);

        // Save sender name for offline display
        if (d.sender && d.senderId) {
          if (!this._dmNames) this._dmNames = new Map();
          this._dmNames.set(d.senderId.slice(0, 8), d.sender);
        }

        if (ch === this.chMgr.current) {
          showMsg({ sender: d.sender, senderId: d.senderId, text, time: d.ts, route: 'e2e', hops: d.hops, self: false, channel: ch, verified: true, dm: true, msgId: d.msgId, replyTo: d.replyTo, fileMeta: d.fileMeta });
        } else {
          showToast(d.sender, text, 'dm', ch);
        }
        refreshChannelList(); stats();
      }
    } else {
      // Not for us — forward if TTL allows (relay encrypted blob)
      const fwd = { ...d, hops: d.hops + 1 };
      if (this.peers.has(d.targetId)) {
        this.sendTo(d.targetId, fwd);
      } else {
        const tgts = this.gossip.pick([...this.peers.values()].map(p => p.info), [from, d.senderId]);
        for (const t of tgts) this.sendTo(t.id, fwd);
      }
    }
  }

  // Start a DM with a peer (from clicking their name)
  async startDM(peerId) {
    const peer = this.peers.get(peerId) || { info: { name: 'unknown' } };
    const peerRt = this.rt.all.get(peerId);
    const peerName = peer.info?.name || peerRt?.name || 'unknown';
    const ch = this.chMgr.dmChannel(this.id, peerId);
    this.chMgr.switchTo(ch);

    // Save peer name for offline display
    if (!this._dmNames) this._dmNames = new Map();
    this._dmNames.set(peerId.slice(0, 8), peerName);
    DB.setKey('dmNames', Object.fromEntries(this._dmNames));

    if (!this.store.channels.has(ch)) this.store.channels.set(ch, []);
    renderChannel();
    refreshChannelList();
    closeMobileDrawer();
  }

  // ── Report/Ban system ──
  reportPeer(peerId) {
    // Cast our own vote
    this.trust.voteBan(peerId, this.id);
    // Lower their trust locally
    this.trust.onViolation(peerId);
    // Broadcast vote to all peers
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'ban-vote', targetId: peerId, voterId: this.id });
    }
    // Check if ban threshold reached
    const trustedCount = [...this.peers.values()].filter(p => this.trust.getScore(p.info.id) >= 40).length;
    if (this.trust.checkBan(peerId, trustedCount)) {
      this.trust.saveBans();
      sys(`🚫 ${peerId.slice(0, 8)}… banned by community vote`);
    }
    ui();
  }

  onBanVote(d, from) {
    // Only accept votes from peers we somewhat trust
    if (this.trust.getScore(from) < 30) return;
    this.trust.voteBan(d.targetId, d.voterId);
    // Check ban threshold
    const trustedCount = [...this.peers.values()].filter(p => this.trust.getScore(p.info.id) >= 40).length;
    if (this.trust.checkBan(d.targetId, trustedCount)) {
      this.trust.saveBans();
      console.log(`Peer ${d.targetId.slice(0, 8)} banned by community vote`);
    }
    // Forward vote to other peers (gossip)
    for (const [pid] of this.peers) {
      if (pid !== from) this.sendTo(pid, d);
    }
  }

  // ── Moderation: report a message ──
  reportMessage(msg) {
    const ch = msg.channel || 'general';
    const ctx = this.store.getChannel(ch);
    const isDM = this.chMgr.isDM(ch);
    const report = this.mod.createReport(msg, ctx, this.id, { isDM, reason: 'User report' });

    // If we're admin, add directly
    if (this.mod.isAdmin) {
      this.mod.addReport(report);
      ui();
      return;
    }
    // Otherwise send to admin peers
    this._sendToAdmins({ type: 'mod-report', report });
    sys('⚑ Report sent to admins');
  }

  // Admin requests older messages for a reported user
  requestHistory(reportedUserId, channel) {
    // Search local store for this user's messages in this channel
    const allMsgs = this.store.getChannel(channel);
    return allMsgs.filter(m => m.senderId === reportedUserId);
  }

  // Admin action on a report
  adminAction(reportId, action) {
    if (!this.mod.isAdmin) return;
    const report = this.mod.reviewReport(reportId, action, this.id);
    if (!report) return;
    if (action === 'ban') {
      // Ban the reported user
      this.trust.banList.add(report.reportedUserId);
      this.trust.saveBans();
      // Broadcast ban
      for (const [pid] of this.peers) {
        this.sendTo(pid, { type: 'ban-vote', targetId: report.reportedUserId, voterId: this.id });
      }
      sys(`🚫 ${report.reportedUserName} banned by admin`);
    }
    // Broadcast admin decision to network
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'mod-action', reportId, action, adminId: this.id });
    }
    ui();
  }

  // Admin approves/rejects media
  adminMediaAction(mediaId, approve) {
    if (!this.mod.isAdmin && !this.mod.isMod) return;
    if (approve) this.mod.approveMedia(mediaId);
    else this.mod.rejectMedia(mediaId);
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'mod-media', mediaId, approved: approve });
    }
    renderChannel();
    ui();
  }

  // Handle incoming moderation messages
  onModReport(d, from) {
    if (!this.mod.isAdmin && !this.mod.isMod) {
      this._sendToAdmins(d);
      return;
    }
    if (d.report) {
      this.mod.addReport(d.report);
      setAdminAlert(true);
      showToast('⚠ Report', d.report.targetMsg?.text || 'New report', 'mention', null);
    }
    ui();
  }

  onModAction(d, from) {
    if (d.action === 'ban' && d.reportId) {
      // Find report and apply ban
      const report = this.mod.reports.find(r => r.id === d.reportId);
      if (report) {
        this.trust.banList.add(report.reportedUserId);
        this.trust.saveBans();
      }
    }
    // Forward to other peers so everyone gets admin decisions
    for (const [pid] of this.peers) {
      if (pid !== from) this.sendTo(pid, d);
    }
  }

  onModMedia(d, from) {
    if (d.approved) this.mod.approveMedia(d.mediaId);
    else this.mod.rejectMedia(d.mediaId);
    // Forward media decisions to other peers
    for (const [pid] of this.peers) {
      if (pid !== from) this.sendTo(pid, d);
    }
    scheduleRender(); // Re-render to show/hide media
  }

  // Send to known admin peers — queues if no admin online
  _sendToAdmins(data) {
    // 1. Try direct send to online admin/mod
    for (const [pid] of this.peers) {
      if (this.mod.admins.has(pid) || this.mod.mods.has(pid)) {
        this.sendTo(pid, data);
        return; // Delivered!
      }
    }
    // 2. No admin/mod online — queue for later delivery
    this._queueForAdmin(data);
    // 3. Also relay to one connected peer (they'll queue it too if they can't reach admin)
    for (const [pid] of this.peers) {
      this.sendTo(pid, data);
      return; // Relay to first available peer
    }
    // 4. Completely alone — data is persisted in queue, will flush on next connection
  }

  // Queue admin-targeted data with dedup + TTL + size limit
  _queueForAdmin(data) {
    // Generate a unique ID for dedup
    const qId = data.report?.id || data.reportId || data.mediaId || `q-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    // Don't add duplicates
    if (this.pendingAdminQueue.some(q => q.id === qId)) return;
    this.pendingAdminQueue.push({
      id: qId,
      data: data,
      ts: Date.now(),
    });
    this._pruneAdminQueue();
    DB.setKey('pending:adminQueue', this.pendingAdminQueue);
    console.log(`Queued for admin: ${data.type} (${this.pendingAdminQueue.length} pending)`);
  }

  // Remove expired (>24h) and excess items
  _pruneAdminQueue() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    this.pendingAdminQueue = this.pendingAdminQueue
      .filter(q => q.ts > cutoff)
      .slice(-50); // max 50 items — does NOT count toward 100 msg limit
  }

  // Flush all pending items to a connected admin/mod
  _flushToAdmin(pid) {
    // Verify target is actually admin/mod
    if (!this.mod.admins.has(pid) && !this.mod.mods.has(pid)) return;
    if (!this.pendingAdminQueue.length) return;
    // Verify peer is still connected
    const p = this.peers.get(pid);
    if (!p || p.ch?.readyState !== 'open') return;

    this._pruneAdminQueue();
    let flushed = 0;
    for (const q of this.pendingAdminQueue) {
      this.sendTo(pid, q.data);
      flushed++;
    }
    if (flushed > 0) {
      console.log(`Flushed ${flushed} pending item(s) to admin ${pid.slice(0, 8)}`);
      this.pendingAdminQueue = [];
      DB.setKey('pending:adminQueue', []);
    }
  }

  // Admin: add/remove banned word and broadcast to all peers
  adminAddBannedWord(word, combo) {
    if (!this.mod.isAdmin) return;
    this.mod.addBannedWord(word, combo, this.id);
    this._broadcastBanWords();
  }

  adminRemoveBannedWord(index) {
    if (!this.mod.isAdmin) return;
    this.mod.removeBannedWord(index);
    this._broadcastBanWords();
  }

  // Admin: manage moderators
  adminAddMod(peerId) {
    if (!this.mod.isAdmin) return;
    this.mod.addMod(peerId);
    this._broadcastRoles();
  }

  adminRemoveMod(peerId) {
    if (!this.mod.isAdmin) return;
    this.mod.removeMod(peerId);
    this._broadcastRoles();
  }

  _broadcastRoles() {
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'mod-roles', admins: [...this.mod.admins], mods: [...this.mod.mods] });
    }
    // Update server cache with current genesis + admin info
    this._sendToServer({ type: 'genesis-update', genesis: { ...this.genesis.toPacket(), admins: [...this.mod.admins] } });
  }

  onModRoles(d) {
    if (Array.isArray(d.admins)) { this.mod.admins = new Set(d.admins); DB.setKey('mod:admins', d.admins); }
    if (Array.isArray(d.mods)) { this.mod.mods = new Set(d.mods); DB.setKey('mod:mods', d.mods); }
    this.mod.checkAdmin(this.id);
    ui();
  }

  // Admin: manage ads
  adminAddAd(text, link) {
    if (!this.mod.isAdmin) return;
    this.mod.addAd(text, link, this.id);
    this._broadcastAds();
  }

  adminRemoveAd(index) {
    if (!this.mod.isAdmin) return;
    this.mod.removeAd(index);
    this._broadcastAds();
  }

  _broadcastAds() {
    const ads = this.mod.getAdsPacket();
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'mod-ads', ads });
    }
  }

  onModAds(d, from) {
    if (Array.isArray(d.ads)) {
      this.mod.customAds = d.ads;
      DB.setKey('mod:ads', d.ads);
      // Forward to other peers (exclude sender to prevent loop)
      for (const [pid] of this.peers) {
        if (pid !== from) this.sendTo(pid, d);
      }
    }
  }

  _broadcastBanWords() {
    const packet = this.mod.getBannedWordsPacket();
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'mod-banwords', bannedWords: packet });
    }
  }

  onBanWords(d, from) {
    if (d.bannedWords && this.mod.mergeBannedWords(d.bannedWords)) {
      console.log('Banned words list updated');
      // Forward to other peers (exclude sender)
      for (const [pid] of this.peers) {
        if (pid !== from) this.sendTo(pid, d);
      }
      ui();
    }
  }

  // ── FILE SHARING ──
  async sendFile(file) {
    const ch = this.chMgr.current;
    const result = await this.ft.prepareFile(file);
    if (result.error) { sys(`⚠ ${result.error}`); return; }

    const { meta, chunks } = result;
    const lamport = this.clock.tick();
    const msgId = `${this.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Register media for approval (images/videos need admin approval)
    const needsApproval = meta.fileType.startsWith('image/') || meta.fileType.startsWith('video/');
    if (needsApproval) {
      this.mod.registerMedia(meta.transferId, this.name, this.id, ch, meta.thumb);
      if (this.mod.isAdmin || this.mod.isMod) {
        this.mod.approveMedia(meta.transferId);
        // Will broadcast approval with the file-meta
      }
    }

    // Store as chat message
    const d = {
      type: 'chat', msgId, sender: this.name, senderId: this.id,
      text: '',
      ts: Date.now(), hops: 0, channel: ch, lamport,
      fileMeta: meta,
    };
    d.sig = await this.crypto.sign(d);
    this.gossip.mark(msgId);
    this.store.add({ ...d, _verified: true });
    showMsg({ sender: this.name, senderId: this.id, text: d.text, time: d.ts, route: 'self', hops: 0, self: true, channel: ch, verified: true, msgId, fileMeta: meta });

    // Send meta + chunks to all peers
    const isApproved = this.mod.approvedMedia.has(meta.transferId);
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'file-meta', meta, sender: this.name, senderId: this.id, channel: ch, msgId, approved: isApproved });
      for (let i = 0; i < chunks.length; i++) {
        this.sendTo(pid, { type: 'file-chunk', transferId: meta.transferId, index: i, data: chunks[i], meta });
      }
    }

    // Also send the chat message via gossip
    for (const [pid] of this.peers) this.sendTo(pid, d);
    refreshChannelList(); stats();
  }

  onFileMeta(d, from) {
    const needsApproval = d.meta?.fileType?.startsWith('image/') || d.meta?.fileType?.startsWith('video/');
    if (needsApproval && d.meta) {
      // If sender already approved (admin/mod), auto-approve on our side too
      if (d.approved) {
        this.mod.approveMedia(d.meta.transferId);
      } else {
        this.mod.registerMedia(d.meta.transferId, d.sender || 'unknown', d.senderId || from, d.channel || 'general', d.meta.thumb || '');
        if (this.mod.isAdmin || this.mod.isMod) {
          setAdminAlert(true);
          showToast('📸 Media', `${d.sender || 'Someone'} sent media for review`, 'mention', null);
        }
      }
    }
  }

  onFileChunk(d, from) {
    if (!d.transferId || d.index === undefined || !d.data) return;
    const result = this.ft.receiveChunk(d.transferId, d.index, d.data, d.meta);
    if (result.complete) {
      const file = this.ft.assembleFile(d.transferId);
      if (file) {
        // Store blob URL for rendering
        const url = URL.createObjectURL(file.blob);
        window._fileUrls = window._fileUrls || {};
        window._fileUrls[d.transferId] = { url, meta: file.meta };
        scheduleRender(); // Re-render to show file
      }
    }
  }

  // ── History sync ──
  onHistSync(d) {
    if (!d.messages?.length) return;
    // Filter out DMs (don't sync private messages)
    const pub = d.messages.filter(m => m.type !== 'dm');
    const added = this.store.merge(pub);
    if (added > 0) {
      for (const m of pub) { this.gossip.mark(m.msgId); this.clock.update(m.lamport || 0); this.chMgr.joined.add(m.channel || 'general'); }
      console.log(`Synced ${added} message(s)`);
      scheduleRender(); refreshChannelList();
    }
  }

  // ── DHT ──
  onDHTLook(d, from) { const c = this.rt.closest(d.target, CFG.K); this.sendTo(from, { type: 'dht-lookup-reply', lid: d.lid, target: d.target, nodes: c.map(n => ({ id: n.id, name: n.name })) }); }
  onDHTReply(d) { if (d.nodes) for (const n of d.nodes) this.rt.add(n); ui(); }
  doLookup(t) { const c = this.rt.closest(t, CFG.ALPHA); for (const n of c) if (this.peers.has(n.id)) this.sendTo(n.id, { type: 'dht-lookup', lid: crypto.randomUUID(), target: t }); }

  onHB(d, from) {
    const p = this.peers.get(from);
    if (p) p.seen = Date.now();
    if (d.nodes) for (const n of d.nodes) this.rt.add(n);
    // Merge trust reports from peer
    if (d.trust) this.trust.mergeTrust(d.trust, from);
  }

  startHB() {
    setInterval(() => {
      this.genesis.peerCount = this.peers.size;
      const s = this.snap().slice(0, 15);
      const trustData = this.trust.getShareable();
      for (const [pid] of this.peers) this.sendTo(pid, { type: 'heartbeat', nid: this.id, ts: Date.now(), nodes: s, trust: trustData });
      for (const [pid, p] of this.peers) {
        if (Date.now() - p.seen > CFG.TIMEOUT) { console.log(`${p.info.name} timed out`); this.rt.rm(pid); this.drop(pid); }
      }
      ui();
    }, CFG.HB);
  }

  startRefresh() {
    setInterval(() => {
      const r = [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
      this.doLookup(r);
    }, CFG.REFRESH);
  }

  snap() { const n = []; for (const b of this.rt.bkts) for (const x of b) n.push({ id: x.id, name: x.name }); return n.slice(0, 50); }
  sendTo(pid, d) { const p = this.peers.get(pid); if (p?.ch?.readyState === 'open') try { p.ch.send(JSON.stringify(d)); } catch (e) { console.error('Send:', e); } }

  // ═══════════════════════════════════════
  // SOCIAL FEATURES (v21)
  // ═══════════════════════════════════════

  // ── Typing indicator ──
  sendTyping(channel) {
    if (!this._lastTypingSent || Date.now() - this._lastTypingSent > 2000) {
      this._lastTypingSent = Date.now();
      for (const [pid] of this.peers) {
        this.sendTo(pid, { type: 'typing', channel, senderId: this.id, senderName: this.name });
      }
    }
  }

  onTyping(d, from) {
    if (!d.channel || !d.senderName) return;
    if (!this.typing.has(d.channel)) this.typing.set(d.channel, new Map());
    this.typing.get(d.channel).set(d.senderId || from, { name: d.senderName, ts: Date.now() });
    if (typeof updateTypingUI === 'function') updateTypingUI();
  }

  getTypingUsers(channel) {
    const map = this.typing.get(channel);
    if (!map) return [];
    const now = Date.now();
    const active = [];
    for (const [pid, info] of map) {
      if (now - info.ts < 3500 && pid !== this.id) active.push(info.name);
      else map.delete(pid);
    }
    return active;
  }

  // ── Read receipts (DM only) ──
  sendAck(msgId, from) {
    this.sendTo(from, { type: 'msg-ack', msgId });
  }

  sendReadReceipt(channel) {
    if (!this.chMgr.isDM(channel)) return;
    const msgs = this.store.getChannel(channel);
    for (const m of msgs) {
      if (m.senderId !== this.id && !m._read) {
        m._read = true;
        // Find who sent this DM and send read receipt
        for (const [pid] of this.peers) {
          if (pid === m.senderId || m.senderId?.startsWith(pid?.slice(0, 8))) {
            this.sendTo(pid, { type: 'msg-read', msgId: m.msgId });
          }
        }
      }
    }
  }

  onMsgAck(d, from) {
    const r = this.readReceipts.get(d.msgId) || {};
    r.delivered = true;
    this.readReceipts.set(d.msgId, r);
    scheduleRender();
  }

  onMsgRead(d, from) {
    const r = this.readReceipts.get(d.msgId) || {};
    r.delivered = true;
    r.read = true;
    this.readReceipts.set(d.msgId, r);
    scheduleRender();
  }

  // ── Profile ──
  updateProfile(data) {
    if (data.bio !== undefined) this.profile.bio = data.bio.slice(0, 150);
    if (data.status !== undefined) this.profile.status = data.status;
    if (data.emoji !== undefined) this.profile.emoji = data.emoji;
    if (data.avatar !== undefined) this.profile.avatar = data.avatar;
    DB.setKey('profile', this.profile);
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'profile-update', senderId: this.id, senderName: this.name, profile: { bio: this.profile.bio, status: this.profile.status, emoji: this.profile.emoji, avatar: this.profile.avatar } });
    }
  }

  onProfileUpdate(d, from) {
    if (d.profile && d.senderId) {
      const existing = this.peerProfiles.get(d.senderId) || {};
      this.peerProfiles.set(d.senderId, { ...existing, ...d.profile, lastSeen: Date.now() });
      // Forward to other peers
      for (const [pid] of this.peers) { if (pid !== from) this.sendTo(pid, d); }
    }
    ui();
  }

  getProfile(peerId) {
    if (peerId === this.id) return { ...this.profile, name: this.name, id: this.id, online: true, lastSeen: Date.now() };
    const p = this.peerProfiles.get(peerId) || {};
    const peer = this.peers.get(peerId);
    return { bio: p.bio || '', status: p.status || 'offline', emoji: p.emoji || '', avatar: p.avatar || '', posts: p.posts || [], name: peer?.info?.name || p.name || peerId.slice(0, 8), id: peerId, online: !!peer, lastSeen: peer?.seen || p.lastSeen || 0 };
  }

  // ── Social posts (profile wall) ──
  sendSocialPost(text, imageDataUrl) {
    if (!text?.trim() && !imageDataUrl) return;
    const postId = `post-${this.id.slice(0,8)}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const post = { id: postId, senderId: this.id, senderName: this.name, text: (text || '').trim().slice(0, 500), ts: Date.now(), likes: [] };
    // Attach image as thumbnail (max 100KB base64 for P2P gossip)
    if (imageDataUrl) post.image = imageDataUrl;
    this.profile.posts.push(post);
    if (this.profile.posts.length > 200) this.profile.posts = this.profile.posts.slice(-200);
    DB.setKey('profile', this.profile);
    // Broadcast (image included — compressed thumbnail)
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'social-post', post, hops: 0 });
    }
    if (typeof refreshPlazaFeed === 'function') refreshPlazaFeed();
  }

  onSocialPost(d, from) {
    if (!d.post?.id || !d.post.senderId) return;
    const p = this.peerProfiles.get(d.post.senderId) || { posts: [] };
    if (!p.posts) p.posts = [];
    if (p.posts.some(x => x.id === d.post.id)) return; // dedup
    p.posts.push(d.post);
    if (p.posts.length > 200) p.posts = p.posts.slice(-200);
    p.name = d.post.senderName;
    this.peerProfiles.set(d.post.senderId, p);
    // Gossip forward
    if ((d.hops || 0) < 3) {
      for (const [pid] of this.peers) { if (pid !== from) this.sendTo(pid, { ...d, hops: (d.hops || 0) + 1 }); }
    }
    if (typeof refreshPlazaFeed === 'function') refreshPlazaFeed();
  }

  likeSocialPost(postId, postOwnerId) {
    // Find the post
    const posts = postOwnerId === this.id ? this.profile.posts : (this.peerProfiles.get(postOwnerId)?.posts || []);
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    const idx = post.likes.indexOf(this.id);
    if (idx >= 0) post.likes.splice(idx, 1); else post.likes.push(this.id);
    if (postOwnerId === this.id) DB.setKey('profile', this.profile);
    // Broadcast like
    for (const [pid] of this.peers) {
      this.sendTo(pid, { type: 'social-post-like', postId, postOwnerId, likerId: this.id, toggle: idx < 0 });
    }
    if (typeof refreshPlazaFeed === 'function') refreshPlazaFeed();
  }

  // ── Stories ──
  sendStory(text, bgColor, imageDataUrl) {
    if (!text?.trim() && !imageDataUrl) return;
    const story = { senderId: this.id, senderName: this.name, senderEmoji: this.profile.emoji, text: (text || '').trim().slice(0, 280), bgColor: bgColor || '#22d3ee', ts: Date.now(), expiresAt: Date.now() + 24 * 3600 * 1000 };
    if (imageDataUrl) story.image = imageDataUrl;
    this.stories.set(this.id + '-' + story.ts, story);
    this._saveStories();
    for (const [pid] of this.peers) this.sendTo(pid, { type: 'story', story, hops: 0 });
  }

  onStory(d, from) {
    if (!d.story?.senderId || !d.story.ts) return;
    const key = d.story.senderId + '-' + d.story.ts;
    if (this.stories.has(key)) return;
    if (d.story.expiresAt <= Date.now()) return;
    this.stories.set(key, d.story);
    this._saveStories();
    if ((d.hops || 0) < 3) {
      for (const [pid] of this.peers) { if (pid !== from) this.sendTo(pid, { ...d, hops: (d.hops || 0) + 1 }); }
    }
    ui();
  }

  _getActiveStories() {
    const now = Date.now();
    const active = [];
    let changed = false;
    for (const [key, s] of this.stories) {
      if (s.expiresAt > now) active.push(s);
      else { this.stories.delete(key); changed = true; }
    }
    if (changed) this._saveStories();
    return active;
  }

  _saveStories() {
    const arr = [];
    for (const [, s] of this.stories) arr.push(s);
    DB.setKey('stories', arr);
  }

  // ── Pinned messages ──
  pinMessage(channel, msgId) {
    if (!this.mod.isAdmin && !this.mod.isMod) return;
    if (!this.pins[channel]) this.pins[channel] = [];
    if (this.pins[channel].includes(msgId)) return;
    this.pins[channel].push(msgId);
    if (this.pins[channel].length > 3) this.pins[channel].shift();
    DB.setKey('pins', this.pins);
    for (const [pid] of this.peers) this.sendTo(pid, { type: 'pin', channel, msgId, action: 'pin' });
  }

  unpinMessage(channel, msgId) {
    if (!this.mod.isAdmin && !this.mod.isMod) return;
    if (this.pins[channel]) {
      this.pins[channel] = this.pins[channel].filter(id => id !== msgId);
      DB.setKey('pins', this.pins);
    }
    for (const [pid] of this.peers) this.sendTo(pid, { type: 'pin', channel, msgId, action: 'unpin' });
  }

  onPin(d, from) {
    if (!d.channel || !d.msgId) return;
    if (d.action === 'pin') {
      if (!this.pins[d.channel]) this.pins[d.channel] = [];
      if (!this.pins[d.channel].includes(d.msgId)) this.pins[d.channel].push(d.msgId);
      if (this.pins[d.channel].length > 3) this.pins[d.channel].shift();
    } else if (d.action === 'unpin') {
      if (this.pins[d.channel]) this.pins[d.channel] = this.pins[d.channel].filter(id => id !== d.msgId);
    }
    DB.setKey('pins', this.pins);
    for (const [pid] of this.peers) { if (pid !== from) this.sendTo(pid, d); }
    renderChannel();
  }

  // ── Broadcast mode ──
  setBroadcast(channel, enabled) {
    if (!this.mod.isAdmin) return;
    if (enabled) this.broadcastChannels.add(channel); else this.broadcastChannels.delete(channel);
    DB.setKey('broadcastChannels', [...this.broadcastChannels]);
    for (const [pid] of this.peers) this.sendTo(pid, { type: 'chat', msgId: `bc-${Date.now()}`, sender: this.name, senderId: this.id, text: `📢 ${channel} is now ${enabled ? 'broadcast-only' : 'open to all'}`, ts: Date.now(), hops: 0, channel, lamport: this.clock.tick() });
  }

  isBroadcast(channel) {
    return this.broadcastChannels.has(channel);
  }

  canWrite(channel) {
    if (!this.isBroadcast(channel)) return true;
    return this.mod.isAdmin || this.mod.isMod;
  }

  // ── Badges ──
  getBadges(peerId) {
    const badges = [];
    if (this.mod.admins.has(peerId)) badges.push({ icon: '🛡️', label: 'Admin' });
    if (this.mod.mods.has(peerId)) badges.push({ icon: '⚔️', label: 'Mod' });
    // OG: joined within 24h of genesis
    if (this.genesis.createdAt) {
      const peer = this.peers.get(peerId);
      const peerJoin = peer?.seen || this.peerProfiles.get(peerId)?.lastSeen;
      if (peerJoin && peerJoin - this.genesis.createdAt < 24 * 3600 * 1000) badges.push({ icon: '🏆', label: 'OG' });
    }
    // Active: 10+ msgs in last hour
    const hourAgo = Date.now() - 3600 * 1000;
    const recentMsgs = this.store.getAll().filter(m => m.senderId === peerId && m.ts > hourAgo);
    if (recentMsgs.length >= 10) badges.push({ icon: '⚡', label: 'Active' });
    // New: first seen < 1 hour ago
    const peer = this.peers.get(peerId);
    if (peer && Date.now() - (this.trust.firstSeen?.[peerId] || peer.seen) < 3600 * 1000) badges.push({ icon: '🆕', label: 'New' });
    return badges;
  }

  // ═══ P2P SIGNALING RELAY ═══
  // When bootstrap is down, peers relay signaling for each other

  // Someone asks us to relay their signaling to a target peer
  _onRelayRequest(d, from) {
    if (!d.targetId || !d.fromId) return;
    // If we're connected to the target, forward the request
    if (this.peers.has(d.targetId)) {
      this.sendTo(d.targetId, { type: 'signal-relay', signal: { type: 'relay-offer', fromId: d.fromId, fromName: d.fromName }, relayedBy: this.id });
      console.log(`Relaying signal request from ${d.fromName || d.fromId.slice(0,8)} to ${d.targetId.slice(0,8)}`);
    }
  }

  // Receive a relayed signal — start connection
  _onRelaySignal(d, from) {
    if (!d.signal) return;
    const sig = d.signal;
    if (sig.type === 'relay-offer' && sig.fromId) {
      // Someone wants to connect to us via relay — initiate connection through relay
      if (!this.peers.has(sig.fromId) && !this.pending.has(sig.fromId)) {
        console.log(`Relay connection from ${sig.fromName || sig.fromId.slice(0,8)} via ${from.slice(0,8)}`);
        // Start connection but use relay peer for signaling instead of bootstrap
        this._relayPeer = from;
        this.startConn(sig.fromId, sig.fromName || 'peer');
      }
    } else if (sig.sdp || sig.candidate) {
      // Relayed ICE/SDP — forward to pending connection
      const target = sig.targetId || sig.from;
      if (target) this.onSig({ signal: sig, from: target, fromName: sig.fromName });
    }
  }

  // Override sig() to use relay when bootstrap is down
  sig(to, s) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', to, from: this.id, fromName: this.name, signal: s }));
    } else if (this._relayPeer && this.peers.has(this._relayPeer)) {
      // Bootstrap down — relay signal through a connected peer
      this.sendTo(this._relayPeer, { type: 'signal-relay', signal: { ...s, targetId: to, from: this.id, fromName: this.name } });
    } else {
      // Try any connected peer as relay
      for (const [pid] of this.peers) {
        this.sendTo(pid, { type: 'signal-relay', signal: { ...s, targetId: to, from: this.id, fromName: this.name } });
        return;
      }
    }
  }
}
