// ═══════════════════════════════════════
// 8. UI RENDERING — MeshChat v20
// ═══════════════════════════════════════
const N = new Node();
const REACTIONS = ['👍', '😂', '❤️', '🔥', '😮', '👎'];

function hue(n) { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return `hsl(${((h % 360) + 360) % 360},65%,65%)`; }
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

// ═══ RENDER THROTTLE (perf fix) ═══
let _renderPending = false;
let _renderTimer = null;
function scheduleRender() {
  if (_renderPending) return;
  _renderPending = true;
  if (_renderTimer) cancelAnimationFrame(_renderTimer);
  _renderTimer = requestAnimationFrame(() => {
    _renderPending = false;
    renderChannel();
  });
}

// ═══ TOAST NOTIFICATIONS ═══
const unreadChannels = new Set();
const unreadCounts = new Map(); // channel -> count

// Notification sound (Web Audio API — no file needed)
let _audioCtx;
function playNotifSound() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain); gain.connect(_audioCtx.destination);
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.3);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + 0.3);
  } catch (_) {}
}

function showToast(sender, text, type, channel) {
  if (channel === N.chMgr?.current) return;

  if (channel) {
    unreadChannels.add(channel);
    unreadCounts.set(channel, (unreadCounts.get(channel) || 0) + 1);
  }
  updateUnreadDots();
  refreshChannelList();

  // Play sound if not muted
  if (!channel || !N.isMuted(channel)) playNotifSound();

  const box = document.getElementById('toastBox');
  const t = document.createElement('div');
  const cls = type === 'dm' ? 'toast-dm' : type === 'mention' ? 'toast-mention' : '';
  const icon = type === 'dm' ? '🔒' : type === 'mention' ? '@' : '💬';
  t.className = `toast ${cls}`;
  t.innerHTML = `<span class="toast-icon">${icon}</span><div class="toast-body"><div class="toast-sender">${esc(sender)}</div><div class="toast-text">${esc(text.slice(0, 80))}</div></div>`;
  t.style.cursor = 'pointer';
  t.addEventListener('click', () => {
    if (channel) switchChannel(channel);
    t.remove();
  });
  box.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 5000);
}

function updateUnreadDots() {
  // Hamburger menu dot — show if any unread OR admin alert
  const toggle = document.getElementById('mobToggle');
  if (toggle) {
    const hasUnread = unreadChannels.size > 0 || hasAdminAlert;
    let dot = toggle.querySelector('.unread-dot');
    if (hasUnread && !dot) {
      dot = document.createElement('span');
      dot.className = 'unread-dot';
      toggle.appendChild(dot);
    } else if (!hasUnread && dot) {
      dot.remove();
    }
  }
}

// Track admin alerts separately
let hasAdminAlert = false;
function setAdminAlert(val) {
  hasAdminAlert = val;
  // Update admin tab dot
  const adminTab = document.querySelector('.stab[data-t="admin"]');
  if (adminTab) {
    let dot = adminTab.querySelector('.tab-dot');
    if (val && !dot) {
      dot = document.createElement('span');
      dot.className = 'tab-dot';
      dot.style.cssText = 'display:inline-block;width:6px;height:6px;background:var(--red);border-radius:50%;margin-left:4px;vertical-align:middle;';
      adminTab.appendChild(dot);
    } else if (!val && dot) {
      dot.remove();
    }
  }
  updateUnreadDots();
}

function clearUnread(channel) {
  unreadChannels.delete(channel);
  unreadCounts.delete(channel);
  updateUnreadDots();
  refreshChannelList();
}

function parseText(text) {
  let out = esc(text);
  // Markdown: code blocks first (protect from other formatting)
  out = out.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  // Bold **text**
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Italic *text*
  out = out.replace(/\*(.+?)\*/g, '<i>$1</i>');
  // Strikethrough ~~text~~
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // URLs — make clickable
  out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" class="msg-link">$1</a>');
  // #channel links
  out = out.replace(/#([a-zA-Z0-9_-]+)/g, '<span class="hashtag" data-ch="$1">#$1</span>');
  // @user mentions
  out = out.replace(/@([a-zA-Z0-9_#]+)/g, '<span class="mention">@$1</span>');
  return out;
}

// Reply state
let currentReply = null;
function setReply(msgId, sender, text) {
  // Find the full message for fileMeta
  const msg = N.store.getAll().find(m => m.msgId === msgId);
  currentReply = { msgId, sender, text: (text || '').slice(0, 80) };
  if (msg?.fileMeta) currentReply.fileMeta = { transferId: msg.fileMeta.transferId, fileType: msg.fileMeta.fileType, thumb: msg.fileMeta.thumb };
  const bar = document.getElementById('replyBar');
  if (bar) {
    const preview = msg?.fileMeta?.thumb ? `<img src="${msg.fileMeta.thumb}" style="height:24px;border-radius:3px;margin-right:4px;">` : '';
    const txt = currentReply.text || (msg?.fileMeta ? '📷 Image' : '');
    bar.innerHTML = `<span style="flex:1;display:flex;align-items:center;">${preview}↩ <b>${esc(sender)}</b>: ${esc(txt)}</span><span id="replyClear" style="cursor:pointer;color:var(--t3);">✕</span>`;
    bar.style.display = 'flex';
    document.getElementById('replyClear').addEventListener('click', clearReply);
    document.getElementById('mIn').focus();
  }
}
function clearReply() {
  currentReply = null;
  const bar = document.getElementById('replyBar');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
}

// Mention autocomplete
function showMentionList(query) {
  let el = document.getElementById('mentionList');
  if (!el) { el = document.createElement('div'); el.id = 'mentionList'; el.className = 'mention-list'; document.querySelector('.ibar').appendChild(el); }
  const q = query.toLowerCase();
  const peers = [...N.peers.values()].map(p => p.info.name).filter(n => n.toLowerCase().startsWith(q));
  if (!peers.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = peers.slice(0, 6).map(n => `<div class="mention-item" data-name="${esc(n)}">${esc(n)}</div>`).join('');
  el.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('click', () => {
      const mIn = document.getElementById('mIn');
      const v = mIn.value;
      const atIdx = v.lastIndexOf('@');
      mIn.value = v.slice(0, atIdx) + '@' + item.dataset.name + ' ';
      el.style.display = 'none';
      mIn.focus();
    });
  });
}

// Close action popup
function closeActionPopup() {
  document.querySelectorAll('.msg-action-popup').forEach(p => p.remove());
}

function showMsg({ sender, senderId, text, time, route, hops, self, channel, verified, dm, msgId, fileMeta, replyTo, poll }) {
  const el = document.getElementById('msgs');
  const d = document.createElement('div');
  const dmClass = dm ? ' m-dm' : '';
  d.className = `m ${self ? 'm-me' : 'm-them'}${dmClass}`;
  d.dataset.mid = msgId || '';
  const c = hue(sender);
  const rc = route === 'direct' ? 'mr-d' : route === 'gossip' ? 'mr-g' : route === 'e2e' ? 'mr-e' : 'mr-h';
  const rl = route === 'self' ? '' : route === 'direct' ? 'DIRECT' : route === 'gossip' ? `GOSSIP·${hops}h` : route === 'e2e' ? 'E2E' : `DHT·${hops}h`;
  const ts = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const vBadge = verified ? '<span class="verified" title="Signature verified">✓</span>' : '';
  const editedTag = N.store.getAll().find(m => m.msgId === msgId)?._edited ? ' <span style="font-size:9px;color:var(--t3);">(edited)</span>' : '';

  // Reply quote
  const rTo = replyTo || N.store.getAll().find(m => m.msgId === msgId)?.replyTo;
  let replyHtml = '';
  if (rTo) {
    let replyImg = '';
    if (rTo.fileMeta?.thumb) {
      replyImg = `<img src="${rTo.fileMeta.thumb}" style="height:32px;border-radius:3px;margin-right:4px;">`;
    } else if (rTo.fileMeta?.transferId) {
      const fUrl = window._fileUrls?.[rTo.fileMeta.transferId];
      if (fUrl) replyImg = `<img src="${fUrl.url}" style="height:32px;border-radius:3px;margin-right:4px;">`;
    }
    const replyText = rTo.text || (rTo.fileMeta ? '📷' : '');
    replyHtml = `<div class="reply-quote">${replyImg}<b>${esc(rTo.sender || '?')}:</b> ${esc(replyText.slice(0, 60))}</div>`;
  }

  // File/media content
  let fileContent = '';
  if (fileMeta) {
    const isMedia = fileMeta.fileType?.startsWith('image/') || fileMeta.fileType?.startsWith('video/');
    const status = isMedia ? N.mod.getMediaStatus(fileMeta.transferId) : 'approved';
    const fileUrl = window._fileUrls?.[fileMeta.transferId];
    if (isMedia && status === 'pending') {
      fileContent = `<div class="file-pending"><div class="file-ad">Loading...</div></div>`;
    } else if (isMedia && status === 'rejected') {
      fileContent = `<div class="file-rejected">Media removed</div>`;
    } else if (fileUrl && fileMeta.fileType?.startsWith('image/')) {
      fileContent = `<div class="file-img"><img src="${fileUrl.url}"></div>`;
    } else if (fileUrl) {
      fileContent = `<div class="file-dl"><a href="${fileUrl.url}" download="${esc(fileMeta.fileName)}" style="color:var(--cyan);">📥 ${esc(fileMeta.fileName)}</a></div>`;
    } else if (fileMeta.thumb && status === 'approved') {
      fileContent = `<div class="file-img"><img src="${fileMeta.thumb}" style="opacity:0.7;"></div>`;
    }
  }

  // Poll content
  const pData = poll || N.store.getAll().find(m => m.msgId === msgId)?.poll;
  let pollHtml = '';
  if (pData) {
    const totalVotes = pData.options.reduce((s, o) => s + (o.votes?.length || 0), 0);
    pollHtml = `<div class="poll-box">`;
    for (let i = 0; i < pData.options.length; i++) {
      const o = pData.options[i];
      const cnt = o.votes?.length || 0;
      const pct = totalVotes ? Math.round(cnt / totalVotes * 100) : 0;
      const voted = o.votes?.includes(N.id);
      pollHtml += `<div class="poll-opt${voted ? ' poll-voted' : ''}" data-mid="${esc(msgId)}" data-oi="${i}">
        <div class="poll-bar" style="width:${pct}%"></div>
        <span class="poll-text">${esc(o.text)}</span>
        <span class="poll-pct">${cnt} (${pct}%)</span>
      </div>`;
    }
    pollHtml += `<div class="poll-total">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</div></div>`;
  }

  // Reactions
  const reactions = N.reactions?.get(msgId) || {};
  let reactionsHtml = '';
  const reactEntries = Object.entries(reactions);
  if (reactEntries.length) {
    reactionsHtml = '<div class="msg-reactions">';
    for (const [emoji, users] of reactEntries) {
      if (!users.length) continue;
      const isMine = users.includes(N.id);
      reactionsHtml += `<span class="msg-reaction${isMine ? ' mine' : ''}" data-mid="${esc(msgId)}" data-emoji="${emoji}">${emoji}<span class="msg-reaction-count">${users.length}</span></span>`;
    }
    reactionsHtml += '</div>';
  }

  // Link preview (basic — extract domain from first URL)
  let linkPreviewHtml = '';
  if (text && !fileMeta) {
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      try {
        const url = new URL(urlMatch[0]);
        const domain = url.hostname.replace(/^www\./, '');
        const path = url.pathname !== '/' ? url.pathname.slice(0, 40) : '';
        linkPreviewHtml = `<div class="link-preview"><a href="${esc(urlMatch[0])}" target="_blank" rel="noopener"><div class="link-preview-domain">🔗 ${esc(domain)}</div><div class="link-preview-title">${esc(path || domain)}</div></a></div>`;
      } catch (_) {}
    }
  }

  d.innerHTML = `
    ${!self ? `<div class="ms" style="color:${c}"><span class="msg-sender-click" data-sid="${esc(senderId)}" style="cursor:pointer;">${esc(sender)}</span>${vBadge}${rl ? ` <span class="mr ${rc}">${rl}</span>` : ''}</div>` : ''}
    ${replyHtml}
    <div class="mb">${parseText(text)}${editedTag}${fileContent}${pollHtml}${linkPreviewHtml}</div>
    ${reactionsHtml}
    <div class="mt">${ts}${route !== 'self' ? ` · ${hops}h` : ''}${verified && self ? ' ✓' : ''}</div>`;

  // Hashtag clicks
  d.querySelectorAll('.hashtag').forEach(h => {
    h.addEventListener('click', (e) => { e.preventDefault(); switchChannel(h.dataset.ch); });
  });

  // Sender name click -> profile (FIX 4: touch-friendly)
  const senderClick = d.querySelector('.msg-sender-click');
  if (senderClick) {
    senderClick.addEventListener('click', (e) => { e.stopPropagation(); showProfile(senderClick.dataset.sid); });
    // Touch: direct tap opens profile, prevent ghost clicks
    senderClick.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showProfile(senderClick.dataset.sid);
    }, { passive: false });
  }

  // Reaction toggle clicks
  d.querySelectorAll('.msg-reaction').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); N.sendReaction(btn.dataset.mid, btn.dataset.emoji); });
  });

  // Poll vote clicks
  d.querySelectorAll('.poll-opt').forEach(opt => {
    opt.addEventListener('click', (e) => { e.stopPropagation(); N.votePoll(opt.dataset.mid, parseInt(opt.dataset.oi)); });
  });

  // Long press / click -> action popup (FIX 4: improved touch handling)
  if (msgId) {
    let pressTimer = null;
    let touchMoved = false;
    const openActions = (e) => {
      e.preventDefault(); e.stopPropagation();
      closeActionPopup();
      const popup = document.createElement('div');
      popup.className = 'msg-action-popup';
      let btns = `<div class="action-btn" data-act="reply">↩ Reply</div>`;
      btns += `<div class="action-btn" data-act="react">☺ React</div>`;
      btns += `<div class="action-btn" data-act="forward">↗ Forward</div>`;
      const isBookmarked = N.bookmarks?.some(b => b.msgId === msgId);
      btns += `<div class="action-btn" data-act="bookmark">${isBookmarked ? '★ Unbookmark' : '☆ Bookmark'}</div>`;
      if (self) btns += `<div class="action-btn" data-act="edit">✏ Edit</div>`;
      if (self) btns += `<div class="action-btn" data-act="delete">🗑 Delete</div>`;
      if (!self) btns += `<div class="action-btn" data-act="report">⚑ Report</div>`;
      popup.innerHTML = btns;
      popup.querySelectorAll('.action-btn').forEach(btn => {
        // Use touchend for mobile, click for desktop
        const handleAction = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const act = btn.dataset.act;
          if (act === 'reply') {
            setReply(msgId, sender, text);
          } else if (act === 'react') {
            // Show reaction picker inline
            popup.innerHTML = REACTIONS.map(r => `<span class="reaction-pick" data-emoji="${r}">${r}</span>`).join('');
            popup.querySelectorAll('.reaction-pick').forEach(rb => {
              const handleReact = (re) => { re.stopPropagation(); re.preventDefault(); N.sendReaction(msgId, rb.dataset.emoji); closeActionPopup(); };
              rb.addEventListener('click', handleReact);
              rb.addEventListener('touchend', handleReact, { passive: false });
            });
            return;
          } else if (act === 'forward') {
            const chs = N.chMgr.list().filter(c => c !== channel);
            if (!chs.length) { closeActionPopup(); return; }
            popup.innerHTML = '<div style="font-size:10px;color:var(--t3);margin-bottom:4px;">Forward to:</div>' +
              chs.map(c => `<div class="action-btn" data-fwd="${esc(c)}">${N.chMgr.isDM(c) ? '🔒' : '#'} ${esc(c)}</div>`).join('');
            popup.querySelectorAll('[data-fwd]').forEach(fb => {
              const handleFwd = (fe) => { fe.stopPropagation(); fe.preventDefault(); N.forwardMessage(msgId, fb.dataset.fwd); closeActionPopup(); };
              fb.addEventListener('click', handleFwd);
              fb.addEventListener('touchend', handleFwd, { passive: false });
            });
            return;
          } else if (act === 'bookmark') {
            const isB = N.bookmarks?.some(b => b.msgId === msgId);
            if (isB) N.removeBookmark(msgId); else N.addBookmark(msgId);
          } else if (act === 'edit') {
            const msg = N.store.getAll().find(m => m.msgId === msgId);
            if (msg) { const nt = prompt('Edit:', msg.text); if (nt !== null && nt.trim()) N.editMessage(msgId, nt.trim()); }
          } else if (act === 'delete') {
            if (confirm('Delete?')) N.deleteMessage(msgId);
          } else if (act === 'report') {
            const msg = N.store.getChannel(channel).find(m => m.msgId === msgId);
            if (msg) N.reportMessage(msg);
          }
          closeActionPopup();
        };
        btn.addEventListener('click', handleAction);
        btn.addEventListener('touchend', handleAction, { passive: false });
      });
      d.appendChild(popup);
    };
    // Mobile: long press; Desktop: right click
    d.addEventListener('contextmenu', openActions);
    d.addEventListener('touchstart', (e) => {
      // Don't trigger long press if touching a sender name link
      if (e.target.closest('.msg-sender-click')) return;
      touchMoved = false;
      pressTimer = setTimeout(() => {
        if (!touchMoved) openActions(e);
      }, 500);
    }, { passive: true });
    d.addEventListener('touchend', () => clearTimeout(pressTimer));
    d.addEventListener('touchmove', () => { touchMoved = true; clearTimeout(pressTimer); });
  }

  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function sys(t) {
  const el = document.getElementById('msgs');
  const d = document.createElement('div'); d.className = 'm m-sys';
  d.innerHTML = `<div class="mb">${t}</div>`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
}

function renderChannel() {
  const el = document.getElementById('msgs');
  el.innerHTML = '';
  const ch = N.chMgr.current;
  const isDM = N.chMgr.isDM(ch);

  document.getElementById('curChName').textContent = ch;
  document.getElementById('e2eTag').style.display = isDM ? 'flex' : 'none';
  document.getElementById('gossipTag').style.display = isDM ? 'none' : 'flex';

  // Update topic display
  const topicEl = document.getElementById('chTopic');
  if (topicEl) {
    const topic = channelTopics[ch] || '';
    topicEl.textContent = topic;
    topicEl.title = topic ? `Topic: ${topic}\nClick to edit` : 'Click to set topic';
  }

  // Update active users count
  const activeEl = document.getElementById('activeUsers');
  if (activeEl && !isDM) {
    const count = N.peers.size + 1; // +1 for self
    activeEl.textContent = `(${count} online)`;
  } else if (activeEl) {
    activeEl.textContent = '';
  }

  const msgs = N.store.getChannel(ch);
  // Perf: use DocumentFragment for batch DOM insert
  const frag = document.createDocumentFragment();
  const origAppend = el.appendChild.bind(el);
  // Temporarily redirect appendChild to fragment
  el.appendChild = frag.appendChild.bind(frag);

  for (const m of msgs) {
    const isSelf = m.senderId === N.id;
    const route = isSelf ? 'self' : m.type === 'dm' ? 'e2e' : m.hops === 0 ? 'direct' : m.hops <= 2 ? 'gossip' : 'dht';
    showMsg({
      sender: m.sender, senderId: m.senderId, text: m.text, time: m.ts,
      route, hops: m.hops, self: isSelf, channel: ch,
      verified: m._verified, dm: m.type === 'dm', msgId: m.msgId,
      fileMeta: m.fileMeta, replyTo: m.replyTo, poll: m.poll,
    });
  }

  // Restore and append all at once
  el.appendChild = origAppend;
  el.appendChild(frag);
  el.scrollTop = el.scrollHeight;
}

// ═══ CHANNEL LIST ═══
let _chListTimer = null;
function refreshChannelList() {
  // Throttle channel list refreshes
  if (_chListTimer) return;
  _chListTimer = setTimeout(() => { _chListTimer = null; _doRefreshChannelList(); }, 100);
}

function _doRefreshChannelList() {
  const el = document.getElementById('chList');
  const channels = N.store.getAllChannels();
  for (const ch of N.chMgr.list()) {
    if (!channels.some(c => c.name === ch)) channels.push({ name: ch, count: 0 });
  }

  // Separate public and DM channels
  const pubChs = channels.filter(c => !N.chMgr.isDM(c.name));
  const dmChs = channels.filter(c => N.chMgr.isDM(c.name));

  pubChs.sort((a, b) => { if (a.name === 'general') return -1; if (b.name === 'general') return 1; return b.count - a.count; });
  dmChs.sort((a, b) => b.count - a.count);

  let html = '<div class="ch-section">Channels</div>';
  for (const ch of pubChs) {
    const unread = unreadChannels.has(ch.name) && ch.name !== N.chMgr.current;
    const muted = N.isMuted(ch.name);
    const cnt = unreadCounts.get(ch.name) || 0;
    html += `<div class="ch-item${ch.name === N.chMgr.current ? ' active' : ''}" data-ch="${esc(ch.name)}">
      <div class="ch-hash">#</div>
      <div class="ch-name">${esc(ch.name)}${muted ? ' 🔇' : ''}</div>
      ${unread && cnt > 0 ? `<div class="ch-badge">${cnt > 99 ? '99+' : cnt}</div>` : ch.count ? `<div class="ch-cnt">${ch.count}</div>` : ''}
    </div>`;
  }

  if (dmChs.length) {
    html += '<div class="ch-section">Direct Messages</div>';
    for (const ch of dmChs) {
      const peerName = getDMPeerName(ch.name);
      const unread = unreadChannels.has(ch.name) && ch.name !== N.chMgr.current;
      const cnt = unreadCounts.get(ch.name) || 0;
      html += `<div class="ch-item ch-dm${ch.name === N.chMgr.current ? ' active' : ''}" data-ch="${esc(ch.name)}">
        <div class="ch-hash">🔒</div>
        <div class="ch-name">${esc(peerName)}</div>
        ${unread && cnt > 0 ? `<div class="ch-badge">${cnt > 99 ? '99+' : cnt}</div>` : ch.count ? `<div class="ch-cnt">${ch.count}</div>` : ''}
      </div>`;
    }
  }

  el.innerHTML = html;
  el.querySelectorAll('.ch-item').forEach(item => {
    item.addEventListener('click', () => switchChannel(item.dataset.ch));
  });
}

function getDMPeerName(dmChannel) {
  const parts = dmChannel.replace('dm:', '').split('-');
  const myShort = N.id?.slice(0, 8);
  const peerShort = parts.find(p => p !== myShort) || parts[0];
  // Try connected peers
  for (const [id, p] of N.peers) {
    if (id.slice(0, 8) === peerShort) return p.info.name;
  }
  // Try routing table
  for (const [id, info] of N.rt?.all || []) {
    if (id.slice(0, 8) === peerShort) return info.name;
  }
  // Try message history — find sender name from this DM channel
  const msgs = N.store.getChannel(dmChannel);
  for (const m of msgs) {
    if (m.senderId?.slice(0, 8) === peerShort && m.sender) return m.sender;
  }
  // Check saved DM names
  const saved = N._dmNames?.get(peerShort);
  if (saved) return saved;
  return peerShort;
}

function switchChannel(ch) {
  if (ch.startsWith('dm:')) {
    N.chMgr.current = ch;
    N.chMgr.joined.add(ch);
  } else {
    ch = N.chMgr.switchTo(ch);
  }
  if (!N.store.channels.has(ch)) N.store.channels.set(ch, []);
  clearUnread(ch);
  renderChannel();
  refreshChannelList();
  closeMobileDrawer();
}

// ═══ PEERS ═══
function trustBar(score) {
  const col = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--amber)' : 'var(--red)';
  return `<div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
    <div style="width:40px;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden;">
      <div style="width:${score}%;height:100%;background:${col};border-radius:2px;"></div>
    </div>
    <span style="font-family:var(--mono);font-size:7px;color:${col};">${score}</span>
  </div>`;
}

function refreshPeers() {
  const el = document.getElementById('pList');
  const list = [...N.peers.values()];
  const dhtOnly = [];
  if (N.rt) for (const [id, info] of N.rt.all) if (!N.peers.has(id)) dhtOnly.push(info);

  if (!list.length && !dhtOnly.length) { el.innerHTML = '<div class="empty">No peers yet</div>'; return; }

  let html = '';
  for (const p of list) {
    const c = hue(p.info.name);
    const age = Date.now() - p.seen;
    const st = age < 5000 ? 'active' : Math.round(age / 1000) + 's';
    const hasKey = N.peerKeys.has(p.info.id);
    const vIcon = hasKey ? '<span class="verified">✓</span>' : '';
    const ts = N.trust.getScore(p.info.id);
    const isBanned = N.trust.banList.has(p.info.id);
    html += `<div class="peer${isBanned ? ' peer-banned' : ''}" data-pid="${p.info.id}">
      <div class="pav" style="background:${c}18;color:${c};border:1px solid ${c}33">${p.info.name[0].toUpperCase()}</div>
      <div style="flex:1;min-width:0;">
        <div class="pnm">${esc(p.info.name)}${vIcon}</div>
        <div class="pmt">${p.info.id.slice(0, 8)}… · ${st}</div>
        ${trustBar(ts)}
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end;">
        <span class="pbg pbg-dm" title="Send DM">DM</span>
        <span class="pbg pbg-report" title="Report spam/abuse" data-rpid="${p.info.id}">⚑</span>
      </div>
    </div>`;
  }
  for (const n of dhtOnly.slice(0, 20)) {
    const c = hue(n.name || '?');
    const ts = N.trust.getScore(n.id);
    html += `<div class="peer" style="opacity:0.6">
      <div class="pav" style="background:${c}10;color:${c}88;border:1px solid ${c}22">${(n.name || '?')[0].toUpperCase()}</div>
      <div style="flex:1;min-width:0;">
        <div class="pnm">${esc(n.name || 'anon')}</div>
        <div class="pmt">${n.id.slice(0, 8)}… · DHT</div>
        ${trustBar(ts)}
      </div>
      <span class="pbg pbg-dht">DHT</span>
    </div>`;
  }
  el.innerHTML = html;

  // Wire DM clicks
  el.querySelectorAll('.peer[data-pid]').forEach(item => {
    item.querySelector('.pbg-dm')?.addEventListener('click', (e) => {
      e.stopPropagation();
      N.startDM(item.dataset.pid);
    });
  });

  // Wire report/block clicks
  el.querySelectorAll('.pbg-report').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = btn.dataset.rpid;
      const peerName = N.peers.get(pid)?.info?.name || pid.slice(0, 8);
      if (confirm(`Report ${peerName} for spam/abuse?\nThis sends a ban vote to the network.`)) {
        N.reportPeer(pid);
      }
    });
  });
}

// ═══ DHT / NETWORK ═══
function refreshDHT() {
  const el = document.getElementById('dhtV');
  if (!N.rt) { el.innerHTML = ''; return; }
  const bkts = N.rt.nonEmpty();
  if (!bkts.length) { el.innerHTML = '<div class="empty">DHT table empty</div>'; return; }
  el.innerHTML = bkts.map(b => `<div class="bkt"><div class="bkt-h" onclick="this.nextElementSibling.classList.toggle('open')"><span>Bucket #${b.i}</span><span class="bkt-c">${b.nodes.length}</span></div><div class="bkt-b">${b.nodes.map(n => `<div class="bnd">${esc(n.name || 'anon')} · ${n.id.slice(0, 12)}…${N.peers.has(n.id) ? ' 🔗' : ''}</div>`).join('')}</div></div>`).join('');
}

function drawNet() {
  const cvs = document.getElementById('nCvs'); if (!cvs || !cvs.parentElement.offsetHeight) return;
  const ctx = cvs.getContext('2d'); const r = cvs.parentElement.getBoundingClientRect();
  cvs.width = r.width * 2; cvs.height = r.height * 2; ctx.scale(2, 2);
  const W = r.width, H = r.height, cx = W / 2, cy = H / 2; ctx.clearRect(0, 0, W, H);
  const nodes = [{ x: cx, y: cy, name: 'You', conn: true, self: true }];
  const direct = [...N.peers.values()];
  direct.forEach((p, i) => { const a = (i / Math.max(direct.length, 1)) * Math.PI * 2 - Math.PI / 2; const rad = Math.min(W, H) * 0.3; nodes.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, name: p.info.name, conn: true, self: false }); });
  const dhtOnly = []; if (N.rt) for (const [id, info] of N.rt.all) if (!N.peers.has(id)) dhtOnly.push(info);
  dhtOnly.slice(0, 12).forEach((n, i) => { const a = (i / Math.max(dhtOnly.length, 1)) * Math.PI * 2; const rad = Math.min(W, H) * 0.44; nodes.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, name: n.name, conn: false, self: false }); });
  // Edges
  for (let i = 1; i < nodes.length; i++) { ctx.beginPath(); ctx.moveTo(nodes[0].x, nodes[0].y); ctx.lineTo(nodes[i].x, nodes[i].y); if (nodes[i].conn) { ctx.strokeStyle = 'rgba(34,211,238,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([]); } else { ctx.strokeStyle = 'rgba(167,139,250,0.1)'; ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]); } ctx.stroke(); ctx.setLineDash([]); }
  for (let i = 1; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (nodes[i].conn && nodes[j].conn) { ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y); ctx.strokeStyle = 'rgba(52,211,153,0.08)'; ctx.lineWidth = 0.5; ctx.stroke(); }
  // Nodes
  for (const n of nodes) { const sz = n.self ? 8 : n.conn ? 5 : 3; const col = n.self ? '#22d3ee' : n.conn ? '#34d399' : '#a78bfa'; ctx.beginPath(); ctx.arc(n.x, n.y, sz, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); if (n.self || n.conn) { ctx.beginPath(); ctx.arc(n.x, n.y, sz + 3, 0, Math.PI * 2); ctx.strokeStyle = col + '30'; ctx.lineWidth = 1; ctx.stroke(); } ctx.fillStyle = n.self ? '#22d3ee' : 'rgba(226,232,240,0.5)'; ctx.font = `${n.self ? 9 : 7}px "IBM Plex Mono"`; ctx.textAlign = 'center'; ctx.fillText(n.name || '?', n.x, n.y + sz + 11); }
}

// ═══ FIX 2: Enhanced network stats + connection metrics ═══
function refreshNetSt() {
  const banned = N.trust.banList.size;
  const scores = N.trust.getAllScores();
  const avgTrust = scores.length ? Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length) : 0;
  const g = N.genesis;
  const genInfo = g?.networkId ? `${g.networkId.slice(0, 12)}… · Admin: ${g.adminName || g.adminId?.slice(0, 8) || '?'}` : 'none';

  // Connection metrics
  const peerList = [...N.peers.values()];
  const now = Date.now();

  // Uptime calculation (session start from first peer or ws connect)
  if (!N._sessionStart) N._sessionStart = now;
  const uptimeSec = Math.round((now - N._sessionStart) / 1000);
  const uptimeStr = uptimeSec < 60 ? `${uptimeSec}s` :
    uptimeSec < 3600 ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s` :
    `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  // Peer freshness (avg age of last seen)
  let avgFreshness = 0;
  if (peerList.length) {
    const totalAge = peerList.reduce((s, p) => s + (now - p.seen), 0);
    avgFreshness = Math.round(totalAge / peerList.length / 1000);
  }
  const freshnessStr = avgFreshness < 5 ? '● excellent' : avgFreshness < 15 ? '◐ good' : '○ stale';
  const freshnessCol = avgFreshness < 5 ? 'var(--green)' : avgFreshness < 15 ? 'var(--amber)' : 'var(--red)';

  // WebSocket status
  const wsState = N.ws?.readyState;
  const wsStr = wsState === WebSocket.OPEN ? '● connected' : wsState === WebSocket.CONNECTING ? '◐ connecting' : '○ disconnected';
  const wsCol = wsState === WebSocket.OPEN ? 'var(--green)' : wsState === WebSocket.CONNECTING ? 'var(--amber)' : 'var(--red)';

  // Data channel health
  let openChannels = 0, totalChannels = 0;
  for (const p of peerList) {
    totalChannels++;
    if (p.ch?.readyState === 'open') openChannels++;
  }
  const dcHealth = totalChannels ? Math.round(openChannels / totalChannels * 100) : 0;
  const dcCol = dcHealth >= 80 ? 'var(--green)' : dcHealth >= 50 ? 'var(--amber)' : totalChannels ? 'var(--red)' : 'var(--t3)';

  // Gossip efficiency
  const gossipSeen = N.gossip?.seen?.size || 0;
  const totalMsgs = N.store.getAll().length;

  // Per-peer connection details
  let peerDetails = '';
  if (peerList.length) {
    peerDetails = '<div class="net-section">Peer Connections</div>';
    for (const p of peerList) {
      const age = now - p.seen;
      const ageStr = age < 5000 ? '<1s' : Math.round(age / 1000) + 's';
      const chState = p.ch?.readyState || 'unknown';
      const pcState = p.pc?.connectionState || p.pc?.iceConnectionState || '?';
      const trustScore = N.trust.getScore(p.info.id);
      const stateCol = chState === 'open' ? 'var(--green)' : 'var(--amber)';
      const trustCol = trustScore >= 70 ? 'var(--green)' : trustScore >= 40 ? 'var(--amber)' : 'var(--red)';

      peerDetails += `<div class="net-peer-row">
        <span style="color:${hue(p.info.name)};font-weight:500;">${esc(p.info.name)}</span>
        <span style="color:${stateCol};">ch:${chState}</span>
        <span>ice:${pcState}</span>
        <span>seen:${ageStr}</span>
        <span style="color:${trustCol};">T:${trustScore}</span>
      </div>`;
    }
  }

  document.getElementById('nSt').innerHTML = `
    <div class="net-section">Network Overview</div>
    <div class="net-grid">
      <div class="net-metric">
        <div class="net-metric-val" style="color:var(--green);">${N.peers.size}</div>
        <div class="net-metric-lbl">P2P Peers</div>
      </div>
      <div class="net-metric">
        <div class="net-metric-val" style="color:var(--cyan);">${N.rt?.size || 0}</div>
        <div class="net-metric-lbl">DHT Known</div>
      </div>
      <div class="net-metric">
        <div class="net-metric-val" style="color:var(--violet);">${N.gCnt}</div>
        <div class="net-metric-lbl">Gossip Relayed</div>
      </div>
      <div class="net-metric">
        <div class="net-metric-val" style="color:var(--amber);">${totalMsgs}</div>
        <div class="net-metric-lbl">Stored Msgs</div>
      </div>
    </div>
    <div class="net-section">Connection Health</div>
    <div style="color:${wsCol};">Bootstrap: ${wsStr}</div>
    <div style="color:${dcCol};">DataChannels: ${openChannels}/${totalChannels} open${dcHealth ? ` (${dcHealth}%)` : ''}</div>
    <div style="color:${freshnessCol};">Peer freshness: ${freshnessStr} (avg ${avgFreshness}s)</div>
    <div style="color:var(--t2);">Session uptime: ${uptimeStr}</div>
    <div class="net-section">Protocol Stats</div>
    <div>Fanout:${CFG.FANOUT} TTL:${CFG.TTL} MaxPeers:${CFG.MAX_PEERS}</div>
    <div>Lamport: ${N.clock.time} · Keys: ${N.peerKeys.size}</div>
    <div style="color:var(--green);">🔐 E2E secrets: ${N.dmSecrets.size}</div>
    <div>Gossip cache: ${gossipSeen} entries</div>
    <div style="color:${avgTrust >= 50 ? 'var(--green)' : 'var(--amber)'};">⭐ Avg trust: ${avgTrust} · Tracked: ${scores.length}${banned ? ` · Banned: ${banned}` : ''}</div>
    <div style="color:var(--t3);">🌐 Net: ${genInfo}</div>
    ${peerDetails}`;
}

function stats() {
  document.getElementById('sP').textContent = N.peers.size;
  document.getElementById('sD').textContent = N.rt?.size || 0;
  document.getElementById('sM').textContent = N.store.getAll().length;
  document.getElementById('fV').textContent = CFG.FANOUT;
}

// ═══ PROFILE CARD (FIX 1: isAdmin ordering + FIX 4: touch) ═══
function showProfile(peerId) {
  const peer = N.peers.get(peerId);
  const peerRt = N.rt?.all?.get(peerId);
  const name = peer?.info?.name || peerRt?.name || 'unknown';
  const col = hue(name);
  // FIX 1: isAdmin must be defined BEFORE trust uses it
  const isOnline = N.peers.has(peerId);
  const isAdmin = N.mod.admins.has(peerId);
  const isMod = N.mod.mods.has(peerId);
  const trust = isAdmin ? 100 : N.trust.getScore(peerId);
  const record = N.trust.scores.get(peerId);
  const role = isAdmin ? '🛡️ Admin' : isMod ? '🔧 Mod' : '';
  const connTime = record ? Math.round(record.connectionTime / 60000) : 0;
  const msgsRelayed = record?.msgsRelayed || 0;
  const firstSeen = record?.firstSeen ? new Date(record.firstSeen).toLocaleDateString() : '—';

  const modal = document.getElementById('profileModal');
  const card = document.getElementById('profileCard');
  card.innerHTML = `
    <div class="pc-header">
      <div class="pc-avatar" style="background:${col}18;color:${col};border:2px solid ${col}33">${name[0].toUpperCase()}</div>
      <div>
        <div class="pc-name">${esc(name)} ${role}</div>
        <div class="pc-id">${peerId.slice(0, 16)}…</div>
        <div class="pc-id" style="color:${isOnline ? 'var(--green)' : 'var(--t3)'};">${isOnline ? '● Online' : '○ Offline'}</div>
      </div>
    </div>
    <div class="pc-stats">
      <div class="pc-stat"><div class="pc-stat-val" style="color:${trust >= 70 ? 'var(--green)' : trust >= 40 ? 'var(--amber)' : 'var(--red)'};">${trust}</div><div class="pc-stat-lbl">Trust</div></div>
      <div class="pc-stat"><div class="pc-stat-val">${msgsRelayed}</div><div class="pc-stat-lbl">Relayed</div></div>
      <div class="pc-stat"><div class="pc-stat-val">${connTime}m</div><div class="pc-stat-lbl">Uptime</div></div>
      <div class="pc-stat"><div class="pc-stat-val">${firstSeen}</div><div class="pc-stat-lbl">First seen</div></div>
    </div>
    <div class="pc-actions">
      ${isOnline ? `<div class="pc-btn" id="pcDm" data-pid="${peerId}">🔒 DM</div>` : ''}
      <div class="pc-btn" id="pcBlock" data-pid="${peerId}" style="${N.isBlocked(peerId) ? 'color:var(--red);' : ''}">${N.isBlocked(peerId) ? '🔓 Unblock' : '🚫 Block'}</div>
      <div class="pc-btn" id="pcClose">Close</div>
    </div>`;
  modal.classList.add('open');

  // FIX 4: Remove old listeners by cloning, then add new ones
  const closeHandler = () => modal.classList.remove('open');
  const dmHandler = () => { N.startDM(peerId); modal.classList.remove('open'); };
  const blockHandler = () => {
    if (N.isBlocked(peerId)) N.unblockUser(peerId);
    else N.blockUser(peerId);
    modal.classList.remove('open');
  };

  const pcClose = document.getElementById('pcClose');
  const pcDm = document.getElementById('pcDm');
  const pcBlock = document.getElementById('pcBlock');

  if (pcClose) {
    pcClose.addEventListener('click', closeHandler);
    pcClose.addEventListener('touchend', (e) => { e.preventDefault(); closeHandler(); }, { passive: false });
  }
  if (pcDm) {
    pcDm.addEventListener('click', dmHandler);
    pcDm.addEventListener('touchend', (e) => { e.preventDefault(); dmHandler(); }, { passive: false });
  }
  if (pcBlock) {
    pcBlock.addEventListener('click', blockHandler);
    pcBlock.addEventListener('touchend', (e) => { e.preventDefault(); blockHandler(); }, { passive: false });
  }

  // Close on backdrop click/touch
  const backdropHandler = (e) => {
    if (e.target === modal) {
      e.preventDefault();
      modal.classList.remove('open');
    }
  };
  modal.onclick = backdropHandler;
  modal.ontouchend = (e) => {
    if (e.target === modal) {
      e.preventDefault();
      modal.classList.remove('open');
    }
  };
}

function ui() {
  refreshPeers(); refreshDHT(); drawNet(); refreshNetSt(); refreshChannelList(); stats();
  const adminTab = document.querySelector('.stab[data-t="admin"]');
  if (adminTab) adminTab.style.display = (N.mod?.isAdmin || N.mod?.isMod) ? '' : 'none';
}

function refreshAdmin() {
  const el = document.getElementById('adminPanel');
  const canMod = N.mod?.isAdmin || N.mod?.isMod;
  if (!el || !canMod) { if (el) el.innerHTML = '<div class="empty">Admin/Mod only</div>'; return; }

  const isAdmin = N.mod.isAdmin;
  const reports = N.mod.getPendingReports();
  const summary = N.mod.getAdminSummary();
  const roleLabel = isAdmin ? '🛡️ Admin' : '🔧 Moderator';

  let html = `<div class="ch-section">${roleLabel} Panel</div>`;
  html += `<div style="padding:6px 10px;font-family:var(--mono);font-size:9px;color:var(--t2);line-height:1.6;">
    Reports: ${summary.pendingReports} pending / ${summary.totalReports} total<br>
    Media: ${summary.pendingMedia} pending / ${summary.approvedMedia} approved<br>
    Banned: ${N.trust.banList.size} · Mods: ${N.mod.mods.size}
  </div>`;

  // ── REPORTS (both admin and mod can review) ──
  if (reports.length) {
    html += '<div class="ch-section">Pending Reports</div>';
    for (const r of reports) {
      const ts = new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const autoTag = r.autoFlagged ? '<span style="color:var(--red);font-size:7px;">AUTO</span> ' : '';
      const dmTag = r.isDM ? '<span style="color:var(--amber);font-size:7px;">DM</span> ' : '';
      html += `<div style="padding:8px;margin:4px 0;background:var(--bg2);border:1px solid var(--brd);border-radius:5px;font-size:11px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-weight:600;color:var(--red);">${autoTag}${dmTag}${esc(r.reportedUserName)}</span>
          <span style="font-family:var(--mono);font-size:8px;color:var(--t3);">${ts}</span>
        </div>
        <div style="padding:4px 6px;background:var(--bg0);border-radius:3px;margin-bottom:4px;font-size:11px;color:var(--t1);word-break:break-word;">${esc(r.targetMsg?.text || '')}</div>
        ${r.context?.length ? `<details style="margin-bottom:4px;"><summary style="font-size:8px;color:var(--t3);cursor:pointer;">Context (${r.context.length} msgs)</summary>
          ${r.context.map(c => `<div style="font-size:9px;color:var(--t2);padding:2px 4px;"><b>${esc(c.sender)}:</b> ${esc(c.text)}</div>`).join('')}
        </details>` : ''}
        <div style="display:flex;gap:6px;">
          ${isAdmin ? `<button class="admin-btn admin-ban" data-rid="${r.id}">🚫 Ban</button>` : ''}
          <button class="admin-btn admin-dismiss" data-rid="${r.id}">✓ Dismiss</button>
        </div>
      </div>`;
    }
  } else {
    html += '<div class="empty">No pending reports</div>';
  }

  // ── PENDING MEDIA (admin and mod can review) ──
  const pendingMedia = N.mod.getPendingMedia();
  if (pendingMedia.length) {
    html += `<div class="ch-section">📸 Pending Media (${pendingMedia.length})</div>`;
    for (const m of pendingMedia) {
      const ts = new Date(m.registeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += `<div style="padding:8px;margin:4px 0;background:var(--bg2);border:1px solid var(--brd);border-radius:5px;font-size:11px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-weight:500;">${esc(m.senderName)}</span>
          <span style="font-family:var(--mono);font-size:8px;color:var(--t3);">${ts}</span>
        </div>
        ${m.thumb ? `<img src="${m.thumb}" style="max-width:100%;max-height:120px;border-radius:4px;margin-bottom:4px;display:block;">` : '<div style="color:var(--t3);font-size:10px;margin-bottom:4px;">No preview</div>'}
        <div style="display:flex;gap:6px;">
          <button class="admin-btn admin-dismiss media-approve" data-mediaid="${esc(m.mediaId)}">✓ Approve</button>
          <button class="admin-btn admin-ban media-reject" data-mediaid="${esc(m.mediaId)}">✗ Reject</button>
        </div>
      </div>`;
    }
  }

  // ── ADMIN-ONLY SECTIONS ──
  if (isAdmin) {
    // ── MODERATOR MANAGEMENT ──
    html += '<div class="ch-section">👥 Moderators</div>';
    const connectedPeers = [...N.peers.values()];
    if (connectedPeers.length) {
      for (const p of connectedPeers) {
        const pid = p.info.id;
        const isMod = N.mod.mods.has(pid);
        const isAdm = N.mod.admins.has(pid);
        if (isAdm) continue; // Don't show admin in mod list
        html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px;">
          <span style="flex:1;">${esc(p.info.name)} <span style="font-family:var(--mono);font-size:8px;color:var(--t3);">${pid.slice(0, 8)}</span></span>
          ${isMod
            ? `<button class="admin-btn mod-rm" data-mpid="${pid}" style="font-size:8px;">Remove Mod</button>`
            : `<button class="admin-btn mod-add" data-mpid="${pid}" style="font-size:8px;">Make Mod</button>`
          }
        </div>`;
      }
    } else {
      html += '<div class="empty" style="padding:6px;">No peers connected</div>';
    }

    // ── BANNED WORDS ──
    html += '<div class="ch-section">🚫 Banned Words</div>';
    html += `<div style="padding:6px 8px;">
      <div style="display:flex;gap:4px;margin-bottom:6px;">
        <input id="bwWord" class="ch-new-input" placeholder="Word..." style="flex:2;">
        <input id="bwCombo" class="ch-new-input" placeholder="+ combo" style="flex:2;">
        <button class="admin-btn" id="bwAdd" style="white-space:nowrap;">+</button>
      </div>
    </div>`;
    const bw = N.mod.bannedWords;
    if (bw.length) {
      for (let i = 0; i < bw.length; i++) {
        const b = bw[i];
        html += `<div style="display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:10px;">
          <span style="flex:1;font-family:var(--mono);color:var(--red);">"${esc(b.word)}"${b.combo ? ` + "${esc(b.combo)}"` : ''}</span>
          <span class="bw-del" data-bwi="${i}" style="cursor:pointer;color:var(--t3);font-size:12px;">×</span>
        </div>`;
      }
    } else {
      html += '<div class="empty" style="padding:6px;">No banned words</div>';
    }

    // ── AD MANAGEMENT ──
    html += '<div class="ch-section">📢 Ads (shown during media review)</div>';
    html += `<div style="padding:6px 8px;">
      <div style="display:flex;gap:4px;margin-bottom:6px;">
        <input id="adText" class="ch-new-input" placeholder="Ad text..." style="flex:2;">
        <input id="adLink" class="ch-new-input" placeholder="Link (optional)" style="flex:2;">
        <button class="admin-btn" id="adAdd" style="white-space:nowrap;">+</button>
      </div>
    </div>`;
    const ads = N.mod.customAds;
    if (ads.length) {
      for (let i = 0; i < ads.length; i++) {
        const a = ads[i];
        html += `<div style="display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:10px;">
          <span style="flex:1;color:var(--cyan);">${esc(a.text)}${a.link ? ` → ${esc(a.link).slice(0, 30)}` : ''}</span>
          <span class="ad-del" data-adi="${i}" style="cursor:pointer;color:var(--t3);font-size:12px;">×</span>
        </div>`;
      }
    } else {
      html += '<div class="empty" style="padding:6px;">Using default ads</div>';
    }
  }

  el.innerHTML = html;

  // ── WIRE EVENT HANDLERS ──
  el.querySelectorAll('.admin-ban').forEach(btn => {
    btn.addEventListener('click', () => { N.adminAction(btn.dataset.rid, 'ban'); refreshAdmin(); });
  });
  el.querySelectorAll('.admin-dismiss').forEach(btn => {
    btn.addEventListener('click', () => { N.adminAction(btn.dataset.rid, 'dismissed'); refreshAdmin(); });
  });
  el.querySelectorAll('.mod-add').forEach(btn => {
    btn.addEventListener('click', () => { N.adminAddMod(btn.dataset.mpid); refreshAdmin(); });
  });
  el.querySelectorAll('.mod-rm').forEach(btn => {
    btn.addEventListener('click', () => { N.adminRemoveMod(btn.dataset.mpid); refreshAdmin(); });
  });
  document.getElementById('bwAdd')?.addEventListener('click', () => {
    const w = document.getElementById('bwWord')?.value?.trim();
    const c = document.getElementById('bwCombo')?.value?.trim();
    if (w) { N.adminAddBannedWord(w, c || ''); refreshAdmin(); }
  });
  el.querySelectorAll('.bw-del').forEach(btn => {
    btn.addEventListener('click', () => { N.adminRemoveBannedWord(parseInt(btn.dataset.bwi)); refreshAdmin(); });
  });
  document.getElementById('adAdd')?.addEventListener('click', () => {
    const t = document.getElementById('adText')?.value?.trim();
    const l = document.getElementById('adLink')?.value?.trim();
    if (t) { N.adminAddAd(t, l || ''); refreshAdmin(); }
  });
  el.querySelectorAll('.ad-del').forEach(btn => {
    btn.addEventListener('click', () => { N.adminRemoveAd(parseInt(btn.dataset.adi)); refreshAdmin(); });
  });
  // Media approve/reject
  el.querySelectorAll('.media-approve').forEach(btn => {
    btn.addEventListener('click', () => { N.adminMediaAction(btn.dataset.mediaid, true); refreshAdmin(); });
  });
  el.querySelectorAll('.media-reject').forEach(btn => {
    btn.addEventListener('click', () => { N.adminMediaAction(btn.dataset.mediaid, false); refreshAdmin(); });
  });
}

// ═══════════════════════════════════════
// CHANNEL TOPICS
// ═══════════════════════════════════════
const channelTopics = {};
(async () => { try { await DB.open(); const t = await DB.getKey('channelTopics'); if (t) Object.assign(channelTopics, t); } catch(_) {} })();

function editTopic() {
  const ch = N.chMgr.current;
  if (N.chMgr.isDM(ch)) return;
  const cur = channelTopics[ch] || '';
  const t = prompt(`Set topic for #${ch}:`, cur);
  if (t === null) return;
  channelTopics[ch] = t.slice(0, 200);
  DB.setKey('channelTopics', channelTopics);
  // Broadcast topic to peers
  const topicMsg = { type: 'chat', msgId: `topic-${Date.now()}`, sender: N.name, senderId: N.id, text: `📝 Topic set: ${t.slice(0,200) || '(cleared)'}`, ts: Date.now(), hops: 0, channel: ch, lamport: N.clock.tick() };
  N.gossip.mark(topicMsg.msgId);
  N.store.add({ ...topicMsg, _verified: true });
  for (const [pid] of N.peers) N.sendTo(pid, topicMsg);
  renderChannel();
}

// ═══════════════════════════════════════
// BOOKMARKS / SAVED PANEL
// ═══════════════════════════════════════
function refreshSaved() {
  const el = document.getElementById('savedList');
  if (!el) return;
  if (!N.bookmarks.length) {
    el.innerHTML = '<div class="empty" style="padding:16px;font-size:12px;">No saved messages yet.<br><span style="color:var(--t3);font-size:11px;">Long-press or right-click a message → ☆ Save</span></div>';
    return;
  }
  let html = '';
  for (const b of [...N.bookmarks].reverse()) {
    const ts = new Date(b.ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
    html += `<div class="saved-item" data-ch="${esc(b.channel)}" data-mid="${esc(b.msgId)}">
      <div class="saved-sender">${esc(b.sender)} <span class="saved-rm" data-bmid="${esc(b.msgId)}" title="Remove">✕</span></div>
      <div class="saved-text">${esc((b.text || '').slice(0, 100))}</div>
      <div class="saved-meta"><span>#${esc(b.channel || '?')}</span><span>${ts}</span></div>
    </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.saved-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('saved-rm')) return;
      switchChannel(item.dataset.ch);
      // Scroll to message
      setTimeout(() => {
        const msg = document.querySelector(`.m[data-mid="${item.dataset.mid}"]`);
        if (msg) { msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); msg.style.outline = '1px solid var(--cyan)'; setTimeout(() => { msg.style.outline = ''; }, 2000); }
      }, 100);
    });
  });
  el.querySelectorAll('.saved-rm').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); N.removeBookmark(btn.dataset.bmid); refreshSaved(); });
  });
}

// ═══════════════════════════════════════
// EMOJI PICKER
// ═══════════════════════════════════════
const EMOJI_DATA = {
  'Smileys': ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠','💩','🤡','👹','👺','👻','👽','👾','🤖'],
  'Hands': ['👋','🤚','🖐','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','💪','🦾'],
  'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟'],
  'Animals': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷'],
  'Food': ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🫘','🥐','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🍔','🍟','🌭','🍕','🫓','🥪','🌮','🌯','🫔','🥙','🧆','🥗','🍿','🧂','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍣','🍤','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','☕','🍵','🫖','🥛','🍺','🍻','🥂','🍷','🍸','🍹','🧃','🧊'],
  'Travel': ['🏠','🏡','🏢','🏰','🏯','⛪','🕌','🕍','⛩','🏝','🏖','🏕','⛺','🌋','🗻','🏔','🗼','🗽','⛲','🎡','🎢','🎠','🚀','✈','🚁','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚗','🚕','🚙','🏎','🚌','🚎','🚐','🚑','🚒','🚓','🚲','🛵','🏍','🛺','🚔'],
  'Objects': ['⌚','📱','💻','⌨','🖥','🖨','🖱','🖲','💽','💾','📀','📷','📸','📹','🎥','🔍','🔎','🔬','🔭','📡','🕯','💡','🔦','🏮','📔','📕','📖','📗','📘','📙','📚','📓','📒','📃','📜','📄','📰','🗓','📆','📅','🗒','🗃','📁','📂','✂','📌','📍','🖊','🖋','✒','📝','✏','🔐','🔑','🗝','🔒','🔓','🛡','⚔','🔫'],
  'Symbols': ['💯','🔥','⭐','🌟','✨','⚡','💥','💢','💫','🕳','💣','💬','👁‍🗨','🗨','🗯','💭','💤','🎵','🎶','🏧','🚮','🚰','♿','🚹','🚺','🚻','🚼','🚾','⚠','🚸','⛔','🚫','🚳','🚭','🚯','🚱','🚷','📵','🔞','☢','☣','⬆','↗','➡','↘','⬇','↙','⬅','↖','↕','↔','↩','↪','⤴','⤵','🔃','🔄','🔙','🔚','🔛','🔜','🔝','✅','❌','❓','❔','❕','❗','〰','➰','➿','✳','✴','❇','©','®','™'],
};

let _emojiCat = 'Smileys';
let _emojiSearch = '';

function buildEmojiPicker() {
  const el = document.getElementById('emojiPicker');
  const cats = Object.keys(EMOJI_DATA);
  const catIcons = { Smileys: '😀', Hands: '👋', Hearts: '❤️', Animals: '🐶', Food: '🍕', Travel: '🚀', Objects: '💻', Symbols: '⭐' };

  let emojis = EMOJI_DATA[_emojiCat] || [];
  if (_emojiSearch) {
    emojis = [];
    for (const arr of Object.values(EMOJI_DATA)) emojis.push(...arr);
    // Simple filter: just show all when searching (emoji search by visual not practical without names)
  }

  el.innerHTML = `
    <div class="emoji-picker-search"><input type="text" placeholder="Type to insert..." id="emojiSearchIn" value="${esc(_emojiSearch)}"></div>
    <div class="emoji-cats">${cats.map(c => `<div class="emoji-cat${c === _emojiCat ? ' on' : ''}" data-cat="${c}">${catIcons[c] || c[0]}</div>`).join('')}</div>
    <div class="emoji-grid">${emojis.map(e => `<div class="emoji-cell">${e}</div>`).join('')}</div>`;

  // Category clicks
  el.querySelectorAll('.emoji-cat').forEach(btn => {
    btn.addEventListener('click', () => { _emojiCat = btn.dataset.cat; _emojiSearch = ''; buildEmojiPicker(); });
  });
  // Emoji clicks — insert into input
  el.querySelectorAll('.emoji-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const mIn = document.getElementById('mIn');
      mIn.value += cell.textContent;
      mIn.focus();
    });
  });
  // Search input
  const si = el.querySelector('#emojiSearchIn');
  si?.addEventListener('input', () => {
    const v = si.value;
    if (v) {
      // Direct character input - just add to textarea
      const mIn = document.getElementById('mIn');
      mIn.value += v;
      si.value = '';
      mIn.focus();
    }
  });
}

function toggleEmojiPicker() {
  const el = document.getElementById('emojiPicker');
  if (el.style.display === 'none') {
    el.style.display = 'flex';
    buildEmojiPicker();
  } else {
    el.style.display = 'none';
  }
}

// ═══════════════════════════════════════
// ATTACH MENU
// ═══════════════════════════════════════
function toggleAttachMenu() {
  const m = document.getElementById('attachMenu');
  m.style.display = m.style.display === 'none' ? '' : 'none';
}

function closeAttachMenu() {
  document.getElementById('attachMenu').style.display = 'none';
}

// ═══════════════════════════════════════
// POLL CREATION UI
// ═══════════════════════════════════════
let _pollOptions = ['', ''];

function togglePollCreate() {
  const el = document.getElementById('pollCreate');
  if (el.style.display === 'none') {
    el.style.display = '';
    _pollOptions = ['', ''];
    renderPollOptions();
    document.getElementById('pollQ').value = '';
    document.getElementById('pollQ').focus();
  } else {
    el.style.display = 'none';
  }
}

function renderPollOptions() {
  const el = document.getElementById('pollOpts');
  el.innerHTML = _pollOptions.map((o, i) =>
    `<div style="display:flex;gap:4px;margin-top:4px;"><input class="poll-create-input poll-opt-in" data-idx="${i}" placeholder="Option ${i + 1}" value="${esc(o)}" style="margin:0;">${_pollOptions.length > 2 ? `<span class="poll-opt-rm" data-idx="${i}" style="cursor:pointer;color:var(--t3);padding:6px;">✕</span>` : ''}</div>`
  ).join('');
  el.querySelectorAll('.poll-opt-in').forEach(inp => {
    inp.addEventListener('input', () => { _pollOptions[parseInt(inp.dataset.idx)] = inp.value; });
  });
  el.querySelectorAll('.poll-opt-rm').forEach(btn => {
    btn.addEventListener('click', () => { _pollOptions.splice(parseInt(btn.dataset.idx), 1); renderPollOptions(); });
  });
}

function sendPollFromUI() {
  const q = document.getElementById('pollQ').value.trim();
  const opts = _pollOptions.map(o => o.trim()).filter(Boolean);
  if (!q) return alert('Please enter a question');
  if (opts.length < 2) return alert('At least 2 options needed');
  N.sendPoll(q, opts);
  document.getElementById('pollCreate').style.display = 'none';
}

// ═══════════════════════════════════════
// GLOBAL SEARCH
// ═══════════════════════════════════════
function openGlobalSearch() {
  // Create overlay if not exists
  let ov = document.getElementById('gsearchOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'gsearchOverlay';
    ov.className = 'gsearch-overlay';
    ov.innerHTML = `<div class="gsearch-box">
      <div class="gsearch-header"><input type="text" id="gsearchIn" placeholder="Search all channels..." autofocus><span class="gsearch-close" id="gsearchClose">✕</span></div>
      <div class="gsearch-results" id="gsearchResults"><div class="empty" style="padding:20px;font-size:12px;">Type to search across all channels...</div></div>
    </div>`;
    document.body.appendChild(ov);

    // Close
    document.getElementById('gsearchClose').addEventListener('click', () => { ov.style.display = 'none'; });
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });

    // Search input
    document.getElementById('gsearchIn').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const results = document.getElementById('gsearchResults');
      if (q.length < 2) { results.innerHTML = '<div class="empty" style="padding:20px;font-size:12px;">Type at least 2 characters...</div>'; return; }

      // Search all channels
      const allMsgs = N.store.getAll();
      const matched = allMsgs.filter(m => m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q)).slice(-50).reverse();

      if (!matched.length) { results.innerHTML = `<div class="empty" style="padding:20px;font-size:12px;">No results for "${esc(q)}"</div>`; return; }

      results.innerHTML = matched.map(m => {
        const ts = new Date(m.ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const highlighted = esc(m.text || '').replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
        return `<div class="gsearch-item" data-ch="${esc(m.channel)}" data-mid="${esc(m.msgId)}">
          <span class="gsearch-ch">#${esc(m.channel || '?')}</span> <span class="gsearch-sender">${esc(m.sender || '?')} · ${ts}</span>
          <div class="gsearch-text">${highlighted.slice(0, 150)}</div>
        </div>`;
      }).join('');

      results.querySelectorAll('.gsearch-item').forEach(item => {
        item.addEventListener('click', () => {
          ov.style.display = 'none';
          switchChannel(item.dataset.ch);
          setTimeout(() => {
            const msg = document.querySelector(`.m[data-mid="${item.dataset.mid}"]`);
            if (msg) { msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); msg.style.outline = '1px solid var(--cyan)'; setTimeout(() => { msg.style.outline = ''; }, 2000); }
          }, 100);
        });
      });
    });

    // Escape to close
    document.getElementById('gsearchIn').addEventListener('keydown', (e) => { if (e.key === 'Escape') ov.style.display = 'none'; });
  }

  ov.style.display = 'flex';
  setTimeout(() => document.getElementById('gsearchIn')?.focus(), 50);
}

// ═══════════════════════════════════════
// 9. EVENT HANDLERS
// ═══════════════════════════════════════

// Sidebar tabs
document.querySelectorAll('.stab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.stab').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.spanel').forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    const m = { channels: 'pnChannels', peers: 'pnPeers', saved: 'pnSaved', dht: 'pnDht', net: 'pnNet', admin: 'pnAdmin' };
    document.getElementById(m[t.dataset.t]).classList.add('on');
    if (t.dataset.t === 'net') setTimeout(drawNet, 60);
    if (t.dataset.t === 'admin') { refreshAdmin(); setAdminAlert(false); }
    if (t.dataset.t === 'saved') refreshSaved();
  });
});

// Input
const mIn = document.getElementById('mIn');
function doSend() { const t = mIn.value.trim(); if (!t) return; N.sendChat(t, currentReply); mIn.value = ''; mIn.style.height = 'auto'; clearReply(); }
document.getElementById('sBtn').addEventListener('click', doSend);
mIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
mIn.addEventListener('input', () => {
  mIn.style.height = 'auto'; mIn.style.height = Math.min(mIn.scrollHeight, 80) + 'px';
  // Mention autocomplete
  const v = mIn.value; const atIdx = v.lastIndexOf('@');
  if (atIdx >= 0 && atIdx === v.length - 1 || (atIdx >= 0 && !v.slice(atIdx).includes(' '))) {
    const q = v.slice(atIdx + 1);
    if (q.length >= 0) showMentionList(q); else { const ml = document.getElementById('mentionList'); if (ml) ml.style.display = 'none'; }
  } else { const ml = document.getElementById('mentionList'); if (ml) ml.style.display = 'none'; }
});

// File attach — now through attach menu
document.getElementById('attachBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleAttachMenu(); });
document.querySelectorAll('.attach-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAttachMenu();
    const act = item.dataset.act;
    if (act === 'file') document.getElementById('fileIn').click();
    else if (act === 'poll') togglePollCreate();
    else if (act === 'emoji') toggleEmojiPicker();
  });
});
document.getElementById('fileIn').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await N.sendFile(file);
  e.target.value = '';
});
// Close attach menu on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('#attachBtn') && !e.target.closest('#attachMenu')) closeAttachMenu();
  if (!e.target.closest('.emoji-picker') && !e.target.closest('.attach-item[data-act="emoji"]')) document.getElementById('emojiPicker').style.display = 'none';
});

// Poll creation
document.getElementById('pollAddOpt')?.addEventListener('click', () => { if (_pollOptions.length < 6) { _pollOptions.push(''); renderPollOptions(); } });
document.getElementById('pollSend')?.addEventListener('click', sendPollFromUI);
document.getElementById('pollCreateClose')?.addEventListener('click', () => { document.getElementById('pollCreate').style.display = 'none'; });

// Channel topic click
document.getElementById('chTopic')?.addEventListener('click', editTopic);

// Global search
document.getElementById('globalSearchToggle')?.addEventListener('click', openGlobalSearch);

// New channel input
document.getElementById('chNewIn').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (v) { switchChannel(v); e.target.value = ''; }
  }
});

// Search
document.getElementById('searchToggle').addEventListener('click', () => {
  const si = document.getElementById('searchIn');
  si.style.display = si.style.display === 'none' ? '' : 'none';
  if (si.style.display !== 'none') si.focus();
  else { si.value = ''; renderChannel(); } // Clear search
});
document.getElementById('searchIn').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderChannel(); return; }
  // Filter and re-render with highlights
  const ch = N.chMgr.current;
  const msgs = N.store.getChannel(ch);
  const filtered = msgs.filter(m => m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q));
  const el = document.getElementById('msgs');
  el.innerHTML = '';
  if (!filtered.length) { el.innerHTML = `<div class="empty" style="padding:20px;">No results for "${esc(q)}"</div>`; return; }
  for (const m of filtered) {
    const isSelf = m.senderId === N.id;
    const route = isSelf ? 'self' : m.hops === 0 ? 'direct' : m.hops <= 2 ? 'gossip' : 'dht';
    showMsg({
      sender: m.sender, senderId: m.senderId, text: m.text, time: m.ts,
      route, hops: m.hops, self: isSelf, channel: ch,
      verified: m._verified, dm: m.type === 'dm', msgId: m.msgId, fileMeta: m.fileMeta,
    });
  }
});
document.getElementById('searchIn').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.style.display = 'none';
    e.target.value = '';
    renderChannel();
  }
});

// Setup
document.getElementById('jBtn').addEventListener('click', go);
document.getElementById('nIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

async function go() {
  const n = document.getElementById('nIn').value.trim();
  if (!n) return document.getElementById('nIn').focus();
  document.getElementById('ov').classList.add('gone');
  await N.init(n);
  setInterval(ui, 3000);
}

// Check for stored username on load
(async () => {
  await DB.open();
  const storedName = await DB.getKey('username');
  if (storedName) {
    document.getElementById('nIn').value = storedName;
  }
  document.getElementById('nIn').focus();
})();

// Reset button
document.getElementById('resetBtn').addEventListener('click', async () => {
  if (confirm('This will delete all messages, channels, and your identity. Continue?')) {
    await DB.open();
    await DB.clearAll();
    // Also delete the database itself
    indexedDB.deleteDatabase(CFG.DB_NAME);
    location.reload();
  }
});

// Resize
window.addEventListener('resize', () => setTimeout(drawNet, 80));

// Close action popup on outside click
document.addEventListener('click', () => closeActionPopup());

// ── Mobile drawer ──
function closeMobileDrawer() {
  const sb = document.querySelector('.sidebar');
  if (sb.classList.contains('mob-open')) {
    sb.classList.remove('mob-open');
    const toggle = document.getElementById('mobToggle');
    toggle.classList.remove('active');
    // Restore hamburger icon without destroying dot
    const existing = toggle.querySelector('.unread-dot');
    toggle.textContent = '☰';
    if (existing) toggle.appendChild(existing);
  }
}

const mobToggle = document.getElementById('mobToggle');
const sidebar = document.querySelector('.sidebar');
mobToggle.addEventListener('click', () => {
  const open = sidebar.classList.toggle('mob-open');
  mobToggle.classList.toggle('active', open);
  mobToggle.innerHTML = open ? '&times;' : '&#9776;';
  if (open) setTimeout(drawNet, 100);
});
document.querySelector('.main').addEventListener('click', () => closeMobileDrawer());

// ── Mobile viewport ──
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    document.documentElement.style.height = window.visualViewport.height + 'px';
    document.querySelector('.app').style.height = window.visualViewport.height + 'px';
  });
  window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
}
document.body.addEventListener('touchmove', (e) => { if (!e.target.closest('.msgs,.spanel,.sidebar')) e.preventDefault(); }, { passive: false });
