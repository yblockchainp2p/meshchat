// ═══════════════════════════════════════
// 8. UI RENDERING — MeshChat v1.1.2
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
  // Plaza link — "check Plaza tab" becomes clickable
  out = out.replace(/check Plaza tab/g, '<span class="plaza-link" style="color:var(--cyan);cursor:pointer;text-decoration:underline;">open Plaza ↗</span>');
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
let _popupCooldown = 0;
function closeActionPopup() {
  const popups = document.querySelectorAll('.msg-action-popup');
  if (popups.length) {
    popups.forEach(p => p.remove());
    _popupCooldown = Date.now();
  }
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
      fileContent = `<div class="file-pending"><div class="file-ad">${N.mod.getAdPlaceholder('pending_image')}</div></div>`;
    } else if (isMedia && status === 'rejected') {
      fileContent = `<div class="file-rejected">Media removed</div>`;
    } else if (fileUrl && fileMeta.fileType?.startsWith('image/')) {
      fileContent = `<div class="file-img"><img src="${fileUrl.url}"></div>`;
    } else if (fileUrl) {
      fileContent = `<div class="file-dl"><a href="${fileUrl.url}" download="${esc(fileMeta.fileName)}" style="color:var(--cyan);">📥 ${esc(fileMeta.fileName)}</a></div>`;
    } else if (fileMeta.thumb && status === 'approved') {
      fileContent = `<div class="file-img file-thumb-click" data-tid="${esc(fileMeta.transferId)}"><img src="${fileMeta.thumb}" style="opacity:0.7;cursor:pointer;" title="Tap to load full image"><div style="font-size:9px;color:var(--t3);text-align:center;">Tap to load</div></div>`;
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

  const badgesHtml = senderId ? getBadgeHtml(senderId) : '';
  const receiptHtml = getReceiptHtml(msgId, self, dm);

  // Thread reply count
  let threadHtml = '';
  if (msgId && !replyTo) {
    const threadCount = getThreadReplies(msgId).length;
    if (threadCount > 0) {
      threadHtml = `<div class="msg-thread" data-tmid="${esc(msgId)}" style="font-size:10px;color:var(--cyan);cursor:pointer;margin-top:3px;">💬 ${threadCount} ${threadCount === 1 ? 'reply' : 'replies'}</div>`;
    }
  }

  d.innerHTML = `
    ${!self ? `<div class="ms" style="color:${c}"><span class="msg-sender-click" data-sid="${esc(senderId)}" style="cursor:pointer;">${esc(sender)}</span>${badgesHtml}${vBadge}${rl ? ` <span class="mr ${rc}">${rl}</span>` : ''}</div>` : ''}
    ${replyHtml}
    <div class="mb">${parseText(text)}${editedTag}${fileContent}${pollHtml}${linkPreviewHtml}</div>
    ${reactionsHtml}
    ${threadHtml}
    <div class="mt">${ts}${route !== 'self' ? ` · ${hops}h` : ''}${verified && self ? ' ✓' : ''}${receiptHtml}</div>`;

  // Hashtag clicks
  d.querySelectorAll('.hashtag').forEach(h => {
    h.addEventListener('click', (e) => { e.preventDefault(); switchChannel(h.dataset.ch); });
  });

  // Thumbnail click → request full image from P2P swarm
  d.querySelectorAll('.file-thumb-click').forEach(t => {
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      const tid = t.dataset.tid;
      t.innerHTML = '<div style="padding:8px;text-align:center;font-size:10px;color:var(--cyan);">⏳ Loading from swarm...</div>';
      N.requestFile(tid, sender, senderId, channel, msgId);
    });
  });

  // Plaza link click -> switch to Plaza tab
  d.querySelectorAll('.plaza-link').forEach(pl => {
    pl.addEventListener('click', (e) => {
      e.stopPropagation();
      // Activate Plaza tab
      document.querySelectorAll('.stab').forEach(x => x.classList.remove('on'));
      document.querySelectorAll('.spanel').forEach(x => x.classList.remove('on'));
      const plazaTab = document.querySelector('.stab[data-t="plaza"]');
      if (plazaTab) plazaTab.classList.add('on');
      document.getElementById('pnPlaza')?.classList.add('on');
      refreshPlaza();
    });
  });

  // Thread click -> open thread panel
  d.querySelectorAll('.msg-thread').forEach(t => {
    t.addEventListener('click', (e) => { e.stopPropagation(); showThread(t.dataset.tmid); });
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
      // Cooldown: don't re-open if just closed (prevents touch ghost re-trigger)
      if (Date.now() - _popupCooldown < 400) return;
      closeActionPopup();
      const popup = document.createElement('div');
      popup.className = 'msg-action-popup';
      let btns = `<div class="action-btn" data-act="reply">↩ Reply</div>`;
      btns += `<div class="action-btn" data-act="react">☺ React</div>`;
      btns += `<div class="action-btn" data-act="link">🔗 Copy Link</div>`;
      btns += `<div class="action-btn" data-act="forward">↗ Forward</div>`;
      const isBookmarked = N.bookmarks?.some(b => b.msgId === msgId);
      btns += `<div class="action-btn" data-act="bookmark">${isBookmarked ? '★ Unbookmark' : '☆ Bookmark'}</div>`;
      if (self) btns += `<div class="action-btn" data-act="edit">✏ Edit</div>`;
      if (self) btns += `<div class="action-btn" data-act="delete">🗑 Delete</div>`;
      if (!self && (N.mod.isAdmin || N.mod.isMod)) btns += `<div class="action-btn" data-act="delete">🗑 Delete</div>`;
      if (!self) btns += `<div class="action-btn" data-act="report">⚑ Report</div>`;
      if ((N.mod.isAdmin || N.mod.isMod) && !N.chMgr.isDM(channel)) {
        const isPinned = (N.pins[channel] || []).includes(msgId);
        btns += `<div class="action-btn" data-act="pin">${isPinned ? '📌 Unpin' : '📌 Pin'}</div>`;
      }
      popup.innerHTML = btns;

      // Position: if message is in top half of viewport, show popup below; otherwise above
      d.appendChild(popup);
      requestAnimationFrame(() => {
        const msgRect = d.getBoundingClientRect();
        const viewH = window.innerHeight;
        const popH = popup.offsetHeight || 150;
        if (msgRect.top < viewH / 2) {
          // Message is in top half — show popup below
          popup.style.top = '100%';
          popup.style.bottom = 'auto';
        } else {
          // Message is in bottom half — show popup above
          popup.style.bottom = '100%';
          popup.style.top = 'auto';
        }
      });

      popup.querySelectorAll('.action-btn').forEach(btn => {
        // Use touchend for mobile, click for desktop
        const handleAction = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const act = btn.dataset.act;
          if (act === 'reply') {
            setReply(msgId, sender, text);
          } else if (act === 'link') {
            closeActionPopup();
            copyLink(getMessageLink(channel, msgId));
            return; // Don't call closeActionPopup again below
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
          } else if (act === 'pin') {
            const isPinned = (N.pins[channel] || []).includes(msgId);
            if (isPinned) N.unpinMessage(channel, msgId); else N.pinMessage(channel, msgId);
            updatePinnedBar();
          }
          closeActionPopup();
        };
        btn.addEventListener('click', handleAction);
        btn.addEventListener('touchend', handleAction, { passive: false });
      });
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
    const count = N.peers.size + 1;
    activeEl.textContent = `(${count} online)`;
  } else if (activeEl) {
    activeEl.textContent = '';
  }

  // Update pinned bar
  updatePinnedBar();

  // Send read receipts for DM
  if (isDM && N.id) N.sendReadReceipt(ch);

  // Broadcast mode — disable input if user can't write
  const mIn = document.getElementById('mIn');
  if (mIn) {
    if (!isDM && N.isBroadcast && N.isBroadcast(ch) && !N.canWrite(ch)) {
      mIn.disabled = true;
      mIn.placeholder = '📢 Broadcast channel — only admins can post';
    } else {
      mIn.disabled = false;
      mIn.placeholder = 'Type a message... (#channel @user)';
    }
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

  // Inject script ads into pending image placeholders
  el.querySelectorAll('.ad-script-slot[data-adscript]').forEach(slot => {
    try {
      const code = atob(slot.dataset.adscript);
      const container = document.createElement('div');
      container.innerHTML = code;
      container.querySelectorAll('script').forEach(oldScript => {
        const newScript = document.createElement('script');
        if (oldScript.src) newScript.src = oldScript.src;
        else newScript.textContent = oldScript.textContent;
        slot.appendChild(newScript);
      });
      while (container.firstChild) {
        if (container.firstChild.nodeName !== 'SCRIPT') slot.appendChild(container.firstChild);
        else container.removeChild(container.firstChild);
      }
    } catch (e) { console.error('Ad inject:', e); }
  });

  // Start channel ad timer (5 min interval, per user session)
  _startChannelAdTimer();
}

// ═══ CHANNEL AD TIMER ═══
// Show an ad as the last message every 5 minutes
let _channelAdTimer = null;
let _lastChannelAd = 0;

function _startChannelAdTimer() {
  if (_channelAdTimer) return; // already running
  _channelAdTimer = setInterval(() => {
    if (!N.id || !N.mod) return;
    const now = Date.now();
    if (now - _lastChannelAd < 5 * 60 * 1000) return; // 5 min cooldown
    _lastChannelAd = now;
    _showChannelAd();
  }, 30000); // check every 30s
}

function _showChannelAd() {
  const el = document.getElementById('msgs');
  if (!el) return;
  const adContent = N.mod.getAdPlaceholder('sidebar');
  if (!adContent) return; // no ads configured — don't show anything
  
  const adMsg = document.createElement('div');
  adMsg.className = 'm m-sys channel-ad-msg';
  adMsg.style.display = 'none'; // hidden until ad loads
  adMsg.innerHTML = `<div class="mb" style="text-align:center;">
    <div style="font-size:8px;color:var(--t3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Sponsored</div>
    <div class="ad-inject-zone">${adContent}</div>
  </div>`;
  el.appendChild(adMsg);

  // Inject scripts if any
  adMsg.querySelectorAll('.ad-script-slot[data-adscript]').forEach(slot => {
    try {
      const code = atob(slot.dataset.adscript);
      const div = document.createElement('div');
      div.innerHTML = code;
      div.querySelectorAll('script').forEach(old => {
        const s = document.createElement('script');
        if (old.src) s.src = old.src; else s.textContent = old.textContent;
        slot.appendChild(s);
      });
    } catch (_) {}
  });

  // Show after 3s only if ad loaded, otherwise remove
  setTimeout(() => {
    const zone = adMsg.querySelector('.ad-inject-zone');
    const hasContent = zone && (zone.querySelector('iframe, img, a, ins, [id]') || zone.children.length > 1);
    if (hasContent) {
      adMsg.style.display = '';
      el.scrollTop = el.scrollHeight;
    } else {
      // For non-script ads (text, banner), show immediately
      if (adContent && !adContent.includes('ad-script-slot')) {
        adMsg.style.display = '';
        el.scrollTop = el.scrollHeight;
      } else {
        adMsg.remove();
      }
    }
  }, 3000);
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

  let html = '';

  // Trending section — most active channels in last hour
  const hourAgo = Date.now() - 3600 * 1000;
  const trending = pubChs.map(ch => {
    const msgs = N.store.getChannel(ch.name);
    const recentCount = msgs.filter(m => m.ts > hourAgo).length;
    return { ...ch, recent: recentCount };
  }).filter(ch => ch.recent > 0).sort((a, b) => b.recent - a.recent).slice(0, 3);

  if (trending.length > 0) {
    html += '<div class="ch-section">🔥 Trending</div>';
    for (const ch of trending) {
      html += `<div class="ch-item trending-item" data-ch="${esc(ch.name)}">
        <div class="ch-hash" style="color:var(--amber);">🔥</div>
        <div class="ch-name">${esc(ch.name)}</div>
        <div class="ch-cnt" style="color:var(--amber);">${ch.recent}/h</div>
      </div>`;
    }
  }

  html += '<div class="ch-section">Channels</div>';
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

function switchChannel(ch, skipHash) {
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
  // Update URL hash (don't update for DMs — they contain private IDs)
  if (!skipHash && !ch.startsWith('dm:')) {
    const hash = ch === 'general' ? '' : ch;
    history.replaceState(null, '', hash ? `#${hash}` : window.location.pathname);
  }
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
  showEnhancedProfile(peerId);
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
    html += '<div class="ch-section">📢 Ads</div>';
    html += `<div style="padding:6px 8px;">
      <div style="display:flex;gap:4px;margin-bottom:4px;">
        <select id="adType" class="ch-new-input" style="flex:1;font-size:10px;padding:4px;">
          <option value="text">Text</option>
          <option value="script">Script</option>
          <option value="banner">Banner</option>
          <option value="html">HTML</option>
        </select>
        <select id="adPlacement" class="ch-new-input" style="flex:1;font-size:10px;padding:4px;">
          <option value="pending_image">Pending Image</option>
          <option value="plaza_feed">Plaza Feed</option>
          <option value="sidebar">Sidebar</option>
        </select>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:4px;">
        <input id="adText" class="ch-new-input" placeholder="Text / Image URL..." style="flex:2;">
        <input id="adLink" class="ch-new-input" placeholder="Link (optional)" style="flex:2;">
      </div>
      <textarea id="adScript" class="ch-new-input" placeholder="Script/HTML code (for script/html type)" rows="2" style="font-size:9px;font-family:var(--mono);display:none;margin-bottom:4px;"></textarea>
      <button class="admin-btn" id="adAdd" style="width:100%;">+ Add Ad</button>
    </div>`;
    const ads = N.mod.customAds;
    if (ads.length) {
      for (let i = 0; i < ads.length; i++) {
        const a = ads[i];
        const typeIcon = a.adType === 'script' ? '⚡' : a.adType === 'banner' ? '🖼️' : a.adType === 'html' ? '📄' : '📝';
        const placeBadge = (a.placement || 'pending_image').replace('_', ' ');
        html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:10px;border-bottom:1px solid var(--brd);">
          <span style="opacity:0.6;">${typeIcon}</span>
          <span style="flex:1;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((a.text || a.scriptCode || '').slice(0, 40))}</span>
          <span style="font-size:8px;color:var(--t3);background:var(--bg3);padding:1px 4px;border-radius:3px;">${placeBadge}</span>
          <span class="ad-del" data-adi="${i}" style="cursor:pointer;color:var(--t3);font-size:12px;">×</span>
        </div>`;
      }
    } else {
      html += '<div class="empty" style="padding:6px;">No ads configured</div>';
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
  document.getElementById('adType')?.addEventListener('change', (e) => {
    const sa = document.getElementById('adScript');
    if (sa) sa.style.display = (e.target.value === 'script' || e.target.value === 'html') ? '' : 'none';
  });
  document.getElementById('adAdd')?.addEventListener('click', () => {
    const t = document.getElementById('adText')?.value?.trim();
    const l = document.getElementById('adLink')?.value?.trim();
    const adType = document.getElementById('adType')?.value || 'text';
    const placement = document.getElementById('adPlacement')?.value || 'pending_image';
    const scriptCode = document.getElementById('adScript')?.value?.trim();
    if (!t && !scriptCode) return;
    N.adminAddAd(t || '', l || '', adType, placement, scriptCode || '');
    refreshAdmin();
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
let _emojiTarget = 'mIn'; // which input to insert emoji into

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
    btn.addEventListener('click', (e) => { e.stopPropagation(); _emojiCat = btn.dataset.cat; _emojiSearch = ''; buildEmojiPicker(); });
  });
  // Emoji clicks — insert into input
  el.querySelectorAll('.emoji-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = document.getElementById(_emojiTarget);
      if (target) { target.value += cell.textContent; target.focus(); }
    });
  });
  // Search input
  const si = el.querySelector('#emojiSearchIn');
  si?.addEventListener('click', (e) => e.stopPropagation());
  si?.addEventListener('input', () => {
    const v = si.value;
    if (v) {
      const target = document.getElementById(_emojiTarget);
      if (target) { target.value += v; }
      si.value = '';
      if (target) target.focus();
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
// SHARE POST TO CHANNEL (ephemeral card, 15s)
// ═══════════════════════════════════════
function sharePostToChannel(postId, ownerName, preview) {
  const el = document.getElementById('msgs');
  const card = document.createElement('div');
  card.className = 'm m-sys plaza-share-card';
  card.innerHTML = `
    <div class="plaza-share-inner">
      <div class="plaza-share-badge">🏛️ Plaza</div>
      <div class="plaza-share-text"><b>${esc(ownerName)}</b>: ${esc(preview)}</div>
      <div class="plaza-share-btn" data-goto="${esc(postId)}">View in Plaza →</div>
    </div>`;
  const goToPlaza = (e) => {
    e.stopPropagation();
    e.preventDefault();
    // Switch to Plaza tab and scroll to post
    document.querySelectorAll('.stab').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.spanel').forEach(x => x.classList.remove('on'));
    const plazaTab = document.querySelector('.stab[data-t="plaza"]');
    if (plazaTab) plazaTab.classList.add('on');
    document.getElementById('pnPlaza')?.classList.add('on');
    refreshPlaza();
    // Open mobile sidebar if needed
    const sb = document.querySelector('.sidebar');
    if (sb && window.innerWidth <= 700) {
      sb.classList.add('mob-open');
      const toggle = document.getElementById('mobToggle');
      if (toggle) { toggle.classList.add('active'); toggle.innerHTML = '&times;'; }
    }
    setTimeout(() => {
      const postEl = document.querySelector(`.live-post[data-postid="${CSS.escape(postId)}"]`);
      if (postEl) {
        postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        postEl.style.outline = '2px solid var(--cyan)';
        setTimeout(() => { postEl.style.outline = ''; }, 2500);
      }
    }, 300);
  };
  const btn = card.querySelector('.plaza-share-btn');
  btn.addEventListener('click', goToPlaza);
  btn.addEventListener('touchend', goToPlaza, { passive: false });

  el.appendChild(card);
  el.scrollTop = el.scrollHeight;

  // Auto-remove after 15 seconds
  setTimeout(() => {
    card.style.transition = 'opacity 0.5s, max-height 0.5s';
    card.style.opacity = '0';
    card.style.maxHeight = '0';
    card.style.overflow = 'hidden';
    setTimeout(() => card.remove(), 600);
  }, 15000);

  // Also broadcast to peers so they see the card
  for (const [pid] of N.peers) {
    N.sendTo(pid, { type: 'chat', msgId: `share-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, sender: N.name, senderId: N.id, text: `🏛️ shared a Plaza post → tap to view`, ts: Date.now(), hops: 0, channel: N.chMgr.current, lamport: N.clock.tick(), _plazaShare: { postId, ownerName, preview } });
  }
  showToastSimple('Shared to channel!');
}

// ═══════════════════════════════════════
// CHANNEL STATISTICS
// ═══════════════════════════════════════
function showChannelStats() {
  const ch = N.chMgr.current;
  if (N.chMgr.isDM(ch)) return;
  const msgs = N.store.getChannel(ch);
  if (!msgs.length) { alert('No messages in this channel yet.'); return; }

  // Top senders
  const senderCounts = {};
  const hourCounts = new Array(24).fill(0);
  for (const m of msgs) {
    senderCounts[m.sender || '?'] = (senderCounts[m.sender || '?'] || 0) + 1;
    const hour = new Date(m.ts).getHours();
    hourCounts[hour]++;
  }
  const topSenders = Object.entries(senderCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  // Build overlay
  let ov = document.getElementById('chStatsOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'chStatsOverlay';
    ov.className = 'gsearch-overlay';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';

  const maxHourVal = Math.max(...hourCounts, 1);
  const barsHtml = hourCounts.map((c, i) => {
    const pct = Math.round(c / maxHourVal * 100);
    const isP = i === peakHour;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;">
      <div style="width:100%;background:${isP ? 'var(--cyan)' : 'var(--bg3)'};height:${Math.max(pct, 2)}px;border-radius:2px;transition:height 0.3s;"></div>
      <span style="font-size:7px;color:var(--t3);">${i}</span>
    </div>`;
  }).join('');

  ov.innerHTML = `<div class="gsearch-box" style="max-width:400px;">
    <div class="gsearch-header" style="flex-direction:column;align-items:flex-start;gap:6px;">
      <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
        <span style="font-size:14px;font-weight:600;">📊 #${esc(ch)} Stats</span>
        <span class="gsearch-close" id="chStatsClose">✕</span>
      </div>
      <div style="font-size:11px;color:var(--t2);">${msgs.length} messages total · Peak hour: ${peakHour}:00</div>
    </div>
    <div style="padding:12px;">
      <div style="font-size:10px;color:var(--t3);text-transform:uppercase;margin-bottom:6px;">Activity by Hour</div>
      <div style="display:flex;gap:1px;height:60px;align-items:flex-end;margin-bottom:16px;">${barsHtml}</div>
      <div style="font-size:10px;color:var(--t3);text-transform:uppercase;margin-bottom:6px;">Top Contributors</div>
      ${topSenders.map(([name, cnt], i) => {
        const c = hue(name);
        const pct = Math.round(cnt / msgs.length * 100);
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
          <span style="font-size:10px;color:var(--t3);width:14px;">${i + 1}.</span>
          <span style="font-size:12px;color:${c};font-weight:600;flex:1;">${esc(name)}</span>
          <span style="font-size:10px;color:var(--t3);">${cnt} (${pct}%)</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;

  document.getElementById('chStatsClose').addEventListener('click', () => { ov.style.display = 'none'; });
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
}

// ═══════════════════════════════════════
// THREAD SYSTEM (Slack-style)
// ═══════════════════════════════════════
function getThreadReplies(parentMsgId) {
  const allMsgs = N.store.getAll();
  return allMsgs.filter(m => m.replyTo?.msgId === parentMsgId);
}

function showThread(parentMsgId) {
  const parentMsg = N.store.getAll().find(m => m.msgId === parentMsgId);
  if (!parentMsg) return;

  let panel = document.getElementById('threadPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'threadPanel';
    panel.className = 'thread-panel';
    document.querySelector('.main').appendChild(panel);
  }
  panel.style.display = 'flex';

  const replies = getThreadReplies(parentMsgId);
  const parentC = hue(parentMsg.sender || '?');

  let html = `<div class="thread-header">
    <span style="font-weight:600;font-size:13px;">Thread</span>
    <span class="thread-close" id="threadClose">✕</span>
  </div>
  <div class="thread-parent">
    <div class="ms" style="color:${parentC};font-size:11px;">${esc(parentMsg.sender || '?')}${getBadgeHtml(parentMsg.senderId)}</div>
    <div class="mb" style="font-size:12px;">${parseText(parentMsg.text || '')}</div>
    <div class="mt">${new Date(parentMsg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
  </div>
  <div class="thread-replies">`;

  for (const r of replies) {
    const c = hue(r.sender || '?');
    const ts = new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += `<div class="thread-reply">
      <div class="ms" style="color:${c};font-size:10px;">${esc(r.sender || '?')}${getBadgeHtml(r.senderId)}</div>
      <div class="mb" style="font-size:12px;">${parseText(r.text || '')}</div>
      <div class="mt">${ts}</div>
    </div>`;
  }

  html += `</div>
  <div class="thread-input-wrap">
    <textarea class="thread-input" id="threadInput" placeholder="Reply in thread..." rows="1"></textarea>
    <button class="sbtn" id="threadSend" style="width:auto;padding:0 10px;font-size:11px;">↑</button>
  </div>`;

  panel.innerHTML = html;

  document.getElementById('threadClose').addEventListener('click', () => { panel.style.display = 'none'; });
  document.getElementById('threadSend')?.addEventListener('click', () => {
    const input = document.getElementById('threadInput');
    const text = input?.value?.trim();
    if (!text) return;
    setReply(parentMsgId, parentMsg.sender, parentMsg.text);
    N.sendChat(text, currentReply);
    clearReply();
    input.value = '';
    // Re-render thread
    setTimeout(() => showThread(parentMsgId), 100);
  });
  document.getElementById('threadInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('threadSend')?.click();
    }
  });
}

// ═══════════════════════════════════════
// TYPING INDICATOR UI
// ═══════════════════════════════════════
function updateTypingUI() {
  const bar = document.getElementById('typingBar');
  if (!bar) return;
  const users = N.getTypingUsers(N.chMgr.current);
  if (!users.length) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  const names = users.slice(0, 3).join(', ');
  const dots = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  bar.innerHTML = `<em>${esc(names)}</em> ${users.length === 1 ? 'is' : 'are'} typing${dots}`;
}
setInterval(updateTypingUI, 1000);

// ═══════════════════════════════════════
// PINNED MESSAGES BAR
// ═══════════════════════════════════════
function updatePinnedBar() {
  const bar = document.getElementById('pinnedBar');
  const toggle = document.getElementById('pinToggle');
  if (!bar) return;
  const ch = N.chMgr.current;
  const pins = N.pins[ch] || [];
  if (!pins.length) { bar.style.display = 'none'; if (toggle) toggle.style.display = 'none'; return; }
  if (toggle) toggle.style.display = '';
  const lastPin = pins[pins.length - 1];
  const msg = N.store.getAll().find(m => m.msgId === lastPin);
  bar.style.display = 'flex';
  bar.innerHTML = `📌 <b>${esc(msg?.sender || '?')}:</b> ${esc((msg?.text || '').slice(0, 60))} ${pins.length > 1 ? `<span style="margin-left:auto;font-size:9px;color:var(--t3);">${pins.length} pinned</span>` : ''}`;
  bar.onclick = () => { if (msg) scrollToMessage(lastPin); };
}

// ═══════════════════════════════════════
// READ RECEIPTS
// ═══════════════════════════════════════
function getReceiptHtml(msgId, isSelf, isDM) {
  if (!isSelf || !isDM) return '';
  const r = N.readReceipts.get(msgId);
  if (!r) return '<span class="msg-receipt sent">✓</span>';
  if (r.read) return '<span class="msg-receipt read">✓✓</span>';
  if (r.delivered) return '<span class="msg-receipt delivered">✓✓</span>';
  return '<span class="msg-receipt sent">✓</span>';
}

// ═══════════════════════════════════════
// BADGES
// ═══════════════════════════════════════
function getBadgeHtml(peerId) {
  if (!N.id) return '';
  const badges = N.getBadges(peerId);
  return badges.map(b => {
    const cls = b.label === 'Admin' ? 'badge-admin' : b.label === 'Mod' ? 'badge-mod' : b.label === 'OG' ? 'badge-og' : b.label === 'Active' ? 'badge-active' : 'badge-new';
    return `<span class="user-badge ${cls}">${b.icon}</span>`;
  }).join('');
}

// ═══════════════════════════════════════
// STORIES
// ═══════════════════════════════════════
function refreshStories() {
  const bar = document.getElementById('storiesBar');
  if (!bar) return;
  const stories = N._getActiveStories();

  // Group by sender
  const bySender = new Map();
  for (const s of stories) {
    if (!bySender.has(s.senderId)) bySender.set(s.senderId, []);
    bySender.get(s.senderId).push(s);
  }

  let html = `<div style="text-align:center;cursor:pointer;" class="story-add-wrap">
    <div class="story-avatar add-story" id="storyAddBtn">+</div>
    <div class="story-name">Story</div>
  </div>`;

  const neonColors = ['#00fff7','#ff00e4','#39ff14','#ff3131','#ffaa00','#00aaff','#ff61d8','#b4ff39'];

  for (const [sid, userStories] of bySender) {
    const latest = userStories[userStories.length - 1];
    const name = latest.senderName || sid.slice(0, 6);
    const c = hue(name);
    // Neon color based on sender hash (consistent per user)
    let hash = 0;
    for (let i = 0; i < sid.length; i++) hash = sid.charCodeAt(i) + ((hash << 5) - hash);
    const neon = neonColors[Math.abs(hash) % neonColors.length];
    const neonDark = neon + '33';
    // Show story content thumbnail (not profile photo)
    let innerContent;
    if (latest.image) {
      innerContent = `<div class="story-avatar-inner" style="background-image:url(${latest.image});background-size:cover;background-position:center;"></div>`;
    } else {
      // Show story bg color with text preview
      const bgC = latest.bgColor || '#22d3ee';
      const preview = latest.text ? latest.text.slice(0, 2) : '💬';
      innerContent = `<div class="story-avatar-inner" style="background:${bgC};display:flex;align-items:center;justify-content:center;font-size:14px;color:white;">${preview}</div>`;
    }
    html += `<div style="text-align:center;cursor:pointer;" data-storyuser="${esc(sid)}">
      <div class="story-ring" style="background:conic-gradient(${neon},${neonDark},${neon},${neonDark},${neon});">${innerContent}</div>
      <div class="story-name">${esc(name)}</div>
    </div>`;
  }
  bar.innerHTML = html;

  // Wire clicks
  document.getElementById('storyAddBtn')?.addEventListener('click', () => {
    openStoryCreator();
  });

  bar.querySelectorAll('[data-storyuser]').forEach(el => {
    el.addEventListener('click', () => viewStory(el.dataset.storyuser));
  });
}

function openStoryCreator() {
  let ov = document.getElementById('storyCreator');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'storyCreator';
    ov.className = 'gsearch-overlay';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  let storyImg = null;
  const colors = ['#22d3ee', '#a78bfa', '#f87171', '#34d399', '#fbbf24', '#fb923c', '#1a1a2e'];

  ov.innerHTML = `<div class="gsearch-box" style="max-width:340px;">
    <div class="gsearch-header" style="justify-content:space-between;">
      <span style="font-weight:600;">📖 New Story</span>
      <span class="gsearch-close" id="storyCreatorClose">✕</span>
    </div>
    <div style="padding:12px;">
      <div id="storyImgPreview" style="display:none;margin-bottom:8px;text-align:center;"></div>
      <div style="display:flex;gap:4px;margin-bottom:8px;">
        ${colors.map(c => `<div class="story-color-pick" data-color="${c}" style="width:18px;height:18px;border-radius:50%;background:${c};cursor:pointer;border:2px solid transparent;"></div>`).join('')}
      </div>
      <div class="irow" style="padding:0;">
        <input type="file" id="storyFileIn" accept="image/*" style="display:none;">
        <div style="position:relative;">
          <button class="sbtn" id="storyAttachBtn" style="background:var(--bg2);color:var(--t2);border:1px solid var(--brd);">+</button>
          <div class="attach-menu" id="storyAttachMenu" style="display:none;">
            <div class="attach-item" data-act="story-image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> Image</div>
          </div>
        </div>
        <div class="iwrap"><textarea id="storyText" placeholder="What's happening?" maxlength="280" rows="1" style="font-size:12px;"></textarea></div>
        <button class="sbtn" id="storySubmit">&uarr;</button>
      </div>
    </div>
  </div>`;

  let selectedColor = colors[0];
  ov.querySelectorAll('.story-color-pick').forEach(p => {
    p.addEventListener('click', () => {
      ov.querySelectorAll('.story-color-pick').forEach(x => x.style.borderColor = 'transparent');
      p.style.borderColor = 'white';
      selectedColor = p.dataset.color;
    });
  });
  ov.querySelector('.story-color-pick').style.borderColor = 'white';

  // Attach button for story
  document.getElementById('storyAttachBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = document.getElementById('storyAttachMenu');
    m.style.display = m.style.display === 'none' ? '' : 'none';
  });
  ov.querySelector('[data-act="story-image"]')?.addEventListener('click', () => {
    document.getElementById('storyAttachMenu').style.display = 'none';
    document.getElementById('storyFileIn').click();
  });

  document.getElementById('storyFileIn').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    compressImage(file, 250, 0.4, (dataUrl) => {
      storyImg = dataUrl;
      document.getElementById('storyImgPreview').style.display = '';
      document.getElementById('storyImgPreview').innerHTML = `<img src="${dataUrl}" style="max-height:120px;border-radius:8px;"><br><span style="font-size:9px;color:var(--t3);cursor:pointer;" id="storyImgRm">✕ Remove</span>`;
      document.getElementById('storyImgRm')?.addEventListener('click', () => {
        storyImg = null;
        document.getElementById('storyImgPreview').style.display = 'none';
      });
    });
  });

  document.getElementById('storyCreatorClose').addEventListener('click', () => { ov.style.display = 'none'; });
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
  document.getElementById('storySubmit').addEventListener('click', () => {
    const text = document.getElementById('storyText').value.trim();
    if (!text && !storyImg) return;
    N.sendStory(text, selectedColor, storyImg);
    ov.style.display = 'none';
    refreshStories();
  });
  document.getElementById('storyText')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('storySubmit')?.click(); }
  });
}

function viewStory(senderId) {
  const stories = [];
  for (const [, s] of N.stories) {
    if (s.senderId === senderId && s.expiresAt > Date.now()) stories.push(s);
  }
  if (!stories.length) return;
  let idx = 0;

  const show = () => {
    const s = stories[idx];
    const ago = Math.round((Date.now() - s.ts) / 60000);
    const timeStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;

    let ov = document.getElementById('storyViewer');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'storyViewer';
      ov.className = 'story-viewer';
      document.body.appendChild(ov);
    }
    ov.style.display = 'flex';
    const canDelete = s.senderId === N.id || N.mod.isAdmin || N.mod.isMod;
    ov.innerHTML = `
      <div class="story-header"><span class="story-header-name">${esc(s.senderName || '?')}</span><span class="story-header-time">${timeStr}</span></div>
      <span class="story-close" id="storyClose">✕</span>
      ${canDelete ? `<span id="storyDelete" style="position:absolute;top:16px;right:50px;font-size:14px;color:#f87171;cursor:pointer;z-index:701;">🗑</span>` : ''}
      <div class="story-content" style="background:${s.image ? '#000' : (s.bgColor || '#22d3ee')};color:white;flex-direction:column;gap:12px;">
        ${s.image ? `<img src="${s.image}" style="max-width:100%;max-height:50vh;border-radius:8px;">` : ''}
        ${s.text ? `<div>${esc(s.text)}</div>` : ''}
      </div>`;
    document.getElementById('storyClose').onclick = () => { ov.style.display = 'none'; };
    document.getElementById('storyDelete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Delete this story?')) return;
      const key = s.senderId + '-' + s.ts;
      N.deleteStory(key);
      ov.style.display = 'none';
      refreshStories();
    });
    ov.onclick = (e) => {
      if (e.target === ov || e.target.classList.contains('story-content')) {
        idx++;
        if (idx < stories.length) show(); else ov.style.display = 'none';
      }
    };
  };
  show();
}

// ═══════════════════════════════════════
// PLAZA (Stories + Social Posts with images)
// ═══════════════════════════════════════
let _plazaPostImage = null; // { dataUrl, file } for pending post image

function refreshPlaza() {
  refreshStories();
  refreshPlazaFeed();
}

function refreshPlazaFeed() {
  const el = document.getElementById('plazaFeed');
  if (!el) return;

  // Collect all posts from all users
  const allPosts = [];
  for (const p of (N.profile.posts || [])) allPosts.push(p);
  for (const [, prof] of N.peerProfiles) {
    for (const p of (prof.posts || [])) allPosts.push(p);
  }
  allPosts.sort((a, b) => b.ts - a.ts);

  // Ad HTML generator — returns '' if no ads configured
  // Ad slot starts hidden, becomes visible when script loads content
  const makeAdHtml = () => {
    const adContent = N.mod.getAdPlaceholder('plaza_feed');
    if (!adContent) return '';
    return `<div class="plaza-ad-slot" style="padding:12px;border-bottom:1px solid var(--brd);text-align:center;display:none;" data-adslot="1">
      <div style="font-size:8px;color:var(--t3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Sponsored</div>
      <div class="ad-inject-zone">${adContent}</div>
    </div>`;
  };

  if (!allPosts.length) {
    const adSlot = makeAdHtml();
    el.innerHTML = `<div class="empty" style="padding:20px;font-size:12px;">No posts yet. Be the first to share!</div>${adSlot}`;
    if (adSlot) _injectPlazaAds(el);
    return;
  }

  // Build posts with ads every 5 posts
  let html = '';
  const posts = allPosts.slice(0, 50);
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const c = hue(p.senderName || '?');
    const profile = N.getProfile(p.senderId);
    const emoji = profile.emoji || (p.senderName || '?')[0]?.toUpperCase();
    const hasAvatar = profile.avatar?.startsWith('data:');
    const avatarStyle = hasAvatar
      ? `background-image:url(${profile.avatar});background-size:cover;background-position:center;color:transparent;`
      : `background:${c}18;color:${c};`;
    const ago = timeAgo(p.ts);
    const liked = p.likes?.includes(N.id);
    const likeCount = p.likes?.length || 0;
    const badges = getBadgeHtml(p.senderId);
    const imgHtml = p.image ? `<div class="plaza-post-img"><img src="${p.image}" alt="" style="max-width:100%;border-radius:8px;margin-bottom:6px;"></div>` : '';
    html += `<div class="live-post" data-postid="${esc(p.id)}">
      <div class="live-post-header">
        <div class="live-post-avatar" style="${avatarStyle}">${hasAvatar ? '' : emoji}</div>
        <div>
          <span class="live-post-name" data-pid="${esc(p.senderId)}" style="color:${c};">${esc(p.senderName || '?')}${badges}</span>
          <div class="live-post-time">${ago}</div>
        </div>
      </div>
      ${imgHtml}
      <div class="live-post-text">${parseText(p.text)}</div>
      <div class="live-post-actions">
        <span class="live-post-action${liked ? ' liked' : ''}" data-postid="${esc(p.id)}" data-owner="${esc(p.senderId)}">${liked ? '❤️' : '🤍'} ${likeCount || ''}</span>
        <span class="live-post-action" data-postshare="${esc(p.id)}" data-shareowner="${esc(p.senderId)}" data-sharename="${esc(p.senderName || '?')}" data-sharetext="${esc((p.text || '').slice(0,60))}">↗ Share</span>
        <span class="live-post-action" data-postcopy="${esc(p.id)}">🔗 Link</span>
        ${(p.senderId === N.id || N.mod.isAdmin || N.mod.isMod) ? `<span class="live-post-action" data-postdelete="${esc(p.id)}" data-delowner="${esc(p.senderId)}" style="color:var(--red);">🗑</span>` : ''}
      </div>
    </div>`;
    // Insert ad every 5 posts
    if ((i + 1) % 5 === 0) html += makeAdHtml();
  }
  el.innerHTML = html;

  // Wire clicks
  el.querySelectorAll('.live-post-name').forEach(n => {
    n.addEventListener('click', () => showProfile(n.dataset.pid));
  });
  el.querySelectorAll('.live-post-action[data-postid]').forEach(btn => {
    btn.addEventListener('click', () => {
      N.likeSocialPost(btn.dataset.postid, btn.dataset.owner);
    });
  });
  el.querySelectorAll('.live-post-action[data-postshare]').forEach(btn => {
    btn.addEventListener('click', () => {
      const postId = btn.dataset.postshare;
      const ownerName = btn.dataset.sharename;
      const preview = btn.dataset.sharetext || 'a post';
      // Send ephemeral share card to current channel
      sharePostToChannel(postId, ownerName, preview);
    });
  });
  // Copy Link handler
  el.querySelectorAll('.live-post-action[data-postcopy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const postId = btn.dataset.postcopy;
      const base = window.location.origin + window.location.pathname;
      const link = `${base}#plaza/${encodeURIComponent(postId)}`;
      copyLink(link);
    });
  });
  // Delete post handler
  el.querySelectorAll('.live-post-action[data-postdelete]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this post?')) return;
      N.deleteSocialPost(btn.dataset.postdelete, btn.dataset.delowner);
      refreshPlazaFeed();
    });
  });
  // Inject script ads in plaza
  _injectPlazaAds(el);
}

// Inject script-type ads into ad slots, show on load, remove if empty after 3s
function _injectPlazaAds(container) {
  container.querySelectorAll('.ad-script-slot[data-adscript]').forEach(slot => {
    try {
      const code = atob(slot.dataset.adscript);
      const div = document.createElement('div');
      div.innerHTML = code;
      div.querySelectorAll('script').forEach(old => {
        const s = document.createElement('script');
        if (old.src) s.src = old.src; else s.textContent = old.textContent;
        slot.appendChild(s);
      });
    } catch (_) {}
  });
  // Show ad slots that have real content, hide/remove empty ones after 3s
  container.querySelectorAll('[data-adslot]').forEach(slot => {
    // Check after 3 seconds if ad actually loaded
    setTimeout(() => {
      const zone = slot.querySelector('.ad-inject-zone');
      const hasContent = zone && (zone.querySelector('iframe, img, a, ins, [id]') || zone.children.length > 1);
      if (hasContent) {
        slot.style.display = '';
      } else {
        slot.remove(); // no ad loaded — remove entirely
      }
    }, 3000);
  });
}

function timeAgo(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

// Image compression for P2P gossip (max ~100KB base64)
function compressImage(file, maxDim, quality, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL('image/jpeg', quality || 0.6));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ═══════════════════════════════════════
// ENHANCED PROFILE CARD
// ═══════════════════════════════════════
function showEnhancedProfile(peerId) {
  const prof = N.getProfile(peerId);
  const c = hue(prof.name);
  const isSelf = peerId === N.id;
  const badges = getBadgeHtml(peerId);
  const isImgAvatar = prof.avatar?.startsWith('data:');
  const avatarHtml = isImgAvatar
    ? `<div class="pc-emoji-avatar" style="width:64px;height:64px;border-radius:50%;background-image:url(${prof.avatar});background-size:cover;background-position:center;margin:0 auto;"></div>`
    : `<div class="pc-emoji-avatar">${prof.emoji || (prof.name[0]?.toUpperCase() || '?')}</div>`;

  // Stats
  const allMsgs = N.store.getAll().filter(m => m.senderId === peerId);
  const channels = new Set(allMsgs.map(m => m.channel)).size;
  const lastSeen = prof.online ? 'Online' : (prof.lastSeen ? timeAgo(prof.lastSeen) + ' ago' : 'Unknown');
  const statusClass = prof.online ? 'pc-status-online' : 'pc-status-offline';
  const statusIcon = prof.status === 'online' ? '🟢' : prof.status === 'dnd' ? '🔴' : prof.status === 'afk' ? '⏳' : '🟢';
  const statusText = prof.status === 'dnd' ? 'Do not disturb' : prof.status === 'afk' ? 'Away' : prof.status || 'Available';

  // Recent posts
  const posts = (prof.posts || []).slice(-5).reverse();
  const postsHtml = posts.length ? posts.map(p => `<div class="pc-post-mini">${esc((p.text || '').slice(0, 80))} <span style="color:var(--t3);font-size:9px;">${timeAgo(p.ts)}</span></div>`).join('') : '<div style="font-size:10px;color:var(--t3);padding:4px 0;">No posts yet</div>';

  const modal = document.getElementById('profileModal');
  const card = document.getElementById('profileCard');
  modal.style.display = 'flex';
  card.innerHTML = `
    <div class="pc-profile-section">
      ${avatarHtml}
      <div style="text-align:center;font-size:14px;font-weight:700;color:${c};">${esc(prof.name)}${badges}</div>
      <div class="pc-status ${statusClass}">${statusIcon} ${esc(statusText)}</div>
      ${prof.bio ? `<div class="pc-bio">"${esc(prof.bio)}"</div>` : ''}
      <div style="font-size:9px;color:var(--t3);text-align:center;">${esc(prof.id.slice(0, 16))}…</div>
    </div>
    <div class="pc-stats">
      <div><span class="pc-stat-val">${allMsgs.length}</span>messages</div>
      <div><span class="pc-stat-val">${channels}</span>channels</div>
      <div><span class="pc-stat-val">${lastSeen}</span>last seen</div>
    </div>
    <div class="pc-posts-section">
      <div style="font-size:9px;color:var(--t3);text-transform:uppercase;margin-bottom:4px;">Recent Posts</div>
      ${postsHtml}
    </div>
    ${isSelf ? `<div class="pc-edit-btn" id="pcEditProfile">✏️ Edit Profile</div>` : ''}
    <div style="display:flex;gap:6px;margin-top:8px;">
      ${!isSelf ? `<button class="pc-btn" id="pcDm">💬 Message</button>` : ''}
      ${!isSelf ? `<button class="pc-btn" id="pcBlock" style="background:var(--red)22;color:var(--red);">🚫 Block</button>` : ''}
      <button class="pc-btn" id="pcClose" style="background:var(--bg3);">Close</button>
    </div>`;

  // Wire events
  document.getElementById('pcClose')?.addEventListener('click', () => { modal.style.display = 'none'; });
  document.getElementById('pcDm')?.addEventListener('click', () => { modal.style.display = 'none'; N.startDM(peerId); });
  document.getElementById('pcBlock')?.addEventListener('click', () => { N.blocked.add(peerId); DB.setKey('blocked', [...N.blocked]); modal.style.display = 'none'; });
  document.getElementById('pcEditProfile')?.addEventListener('click', openProfileEditor);
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
}

function openProfileEditor() {
  document.getElementById('profileModal').style.display = 'none';

  let ov = document.getElementById('profileEditor');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'profileEditor';
    ov.className = 'gsearch-overlay';
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';

  const prof = N.profile;
  const currentAvatar = prof.avatar || prof.emoji || N.name[0]?.toUpperCase() || '?';
  const isImg = prof.avatar?.startsWith('data:');
  const c = hue(N.name);

  ov.innerHTML = `<div class="gsearch-box" style="max-width:360px;">
    <div class="gsearch-header" style="justify-content:space-between;">
      <span style="font-weight:600;">✏️ Edit Profile</span>
      <span class="gsearch-close" id="profEdClose">✕</span>
    </div>
    <div style="padding:16px;">
      <!-- Avatar -->
      <div style="text-align:center;margin-bottom:12px;">
        <div id="profEdAvatar" class="prof-ed-avatar" style="background:${isImg ? 'none' : c + '18'};color:${c};${isImg ? `background-image:url(${prof.avatar});background-size:cover;background-position:center;color:transparent;` : ''}">${isImg ? '' : currentAvatar}</div>
        <div style="margin-top:6px;">
          <label class="prof-ed-upload-btn" id="profEdAvatarBtn">Change Photo<input type="file" id="profEdAvatarIn" accept="image/*" style="display:none;"></label>
        </div>
      </div>
      <!-- Bio -->
      <div class="prof-ed-label">Bio</div>
      <textarea class="prof-ed-input" id="profEdBio" placeholder="Tell people about yourself..." maxlength="150" rows="2">${esc(prof.bio || '')}</textarea>
      <!-- Status -->
      <div class="prof-ed-label">Status</div>
      <div class="prof-ed-status-row">
        <div class="prof-ed-status-opt${prof.status === 'online' || !prof.status ? ' active' : ''}" data-status="online">🟢 Online</div>
        <div class="prof-ed-status-opt${prof.status === 'dnd' ? ' active' : ''}" data-status="dnd">🔴 DND</div>
        <div class="prof-ed-status-opt${prof.status === 'afk' ? ' active' : ''}" data-status="afk">⏳ AFK</div>
      </div>
      <!-- Emoji (optional, instead of photo) -->
      <div class="prof-ed-label">Emoji Avatar <span style="color:var(--t3);font-weight:400;">(or use photo above)</span></div>
      <input class="prof-ed-input" id="profEdEmoji" placeholder="Pick an emoji: 🐱 🚀 💀" value="${esc(prof.emoji || '')}" maxlength="2" style="text-align:center;font-size:20px;">
      <!-- Save -->
      <button class="sbtn" id="profEdSave" style="width:100%;margin-top:12px;font-size:12px;">Save Profile</button>
    </div>
  </div>`;

  let selectedStatus = prof.status || 'online';
  let avatarDataUrl = prof.avatar || null;

  // Status selection
  ov.querySelectorAll('.prof-ed-status-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      ov.querySelectorAll('.prof-ed-status-opt').forEach(x => x.classList.remove('active'));
      opt.classList.add('active');
      selectedStatus = opt.dataset.status;
    });
  });

  // Avatar upload
  document.getElementById('profEdAvatarIn').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    compressImage(file, 150, 0.7, (dataUrl) => {
      avatarDataUrl = dataUrl;
      const av = document.getElementById('profEdAvatar');
      av.style.backgroundImage = `url(${dataUrl})`;
      av.style.backgroundSize = 'cover';
      av.style.backgroundPosition = 'center';
      av.style.color = 'transparent';
      av.textContent = '';
    });
  });

  // Close
  document.getElementById('profEdClose').addEventListener('click', () => { ov.style.display = 'none'; });
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });

  // Save
  document.getElementById('profEdSave').addEventListener('click', () => {
    const bio = document.getElementById('profEdBio').value.trim();
    const emoji = document.getElementById('profEdEmoji').value.trim();
    N.updateProfile({ bio, emoji, status: selectedStatus, avatar: avatarDataUrl });
    ov.style.display = 'none';
  });
}

// ═══════════════════════════════════════
// THEME SYSTEM
// ═══════════════════════════════════════
const THEMES = {
  midnight: { name: 'Midnight', dots: ['#0c0e14','#22d3ee','#34d399'] },
  light:    { name: 'Light',    dots: ['#ffffff','#0891b2','#059669'] },
  nord:     { name: 'Nord',     dots: ['#2e3440','#88c0d0','#a3be8c'] },
  dracula:  { name: 'Dracula',  dots: ['#282a36','#8be9fd','#bd93f9'] },
  ocean:    { name: 'Ocean',    dots: ['#0a192f','#64ffda','#c792ea'] },
  ember:    { name: 'Ember',    dots: ['#1a1110','#fb923c','#f472b6'] },
  matrix:   { name: 'Matrix',   dots: ['#0a0a0a','#00ff41','#00ff41'] },
};

let currentTheme = 'midnight';

function applyTheme(themeName) {
  if (themeName === 'custom') {
    // Custom theme is applied via CSS vars directly
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', themeName);
  }
  currentTheme = themeName;
  DB.setKey('theme', themeName);
}

// Load saved theme on startup
(async () => {
  try {
    await DB.open();
    const saved = await DB.getKey('theme');
    if (saved && (THEMES[saved] || saved === 'custom')) {
      applyTheme(saved);
      // Load custom colors if custom theme
      if (saved === 'custom') {
        const cc = await DB.getKey('themeCustomColors');
        if (cc) {
          for (const [k, v] of Object.entries(cc)) {
            document.documentElement.style.setProperty(k, v);
          }
        }
      }
    }
  } catch(_) {}
})();

function openThemePicker() {
  let picker = document.getElementById('themePicker');
  if (picker) { picker.remove(); return; }

  picker = document.createElement('div');
  picker.id = 'themePicker';
  picker.className = 'theme-picker';
  picker.addEventListener('click', (e) => e.stopPropagation());

  let html = `<div class="theme-picker-title">Choose Theme</div><div class="theme-grid">`;
  for (const [id, t] of Object.entries(THEMES)) {
    const isActive = currentTheme === id ? ' active' : '';
    html += `<div class="theme-card${isActive}" data-theme="${id}">
      <div class="theme-card-dots">${t.dots.map(c => `<div class="theme-card-dot" style="background:${c}"></div>`).join('')}</div>
      <div class="theme-card-name">${t.name}</div>
    </div>`;
  }
  html += `</div>`;

  // Custom color section
  html += `<div class="theme-custom-section">
    <div class="theme-custom-title">Custom Colors</div>
    <div class="theme-color-row"><span class="theme-color-label">Background</span><input type="color" class="theme-color-input" data-var="--bg0" value="${getComputedStyle(document.documentElement).getPropertyValue('--bg0').trim() || '#0c0e14'}"></div>
    <div class="theme-color-row"><span class="theme-color-label">Surface</span><input type="color" class="theme-color-input" data-var="--bg1" value="${getComputedStyle(document.documentElement).getPropertyValue('--bg1').trim() || '#13161e'}"></div>
    <div class="theme-color-row"><span class="theme-color-label">Accent</span><input type="color" class="theme-color-input" data-var="--cyan" value="${getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() || '#22d3ee'}"></div>
    <div class="theme-color-row"><span class="theme-color-label">Text</span><input type="color" class="theme-color-input" data-var="--t1" value="${getComputedStyle(document.documentElement).getPropertyValue('--t1').trim() || '#e2e8f0'}"></div>
  </div>`;

  picker.innerHTML = html;
  document.body.appendChild(picker);

  // Theme card clicks
  picker.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      applyTheme(card.dataset.theme);
      picker.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });

  // Custom color inputs
  picker.querySelectorAll('.theme-color-input').forEach(inp => {
    inp.addEventListener('input', () => {
      document.documentElement.style.setProperty(inp.dataset.var, inp.value);
      // Auto-derive related colors
      if (inp.dataset.var === '--bg0') {
        const bg = inp.value;
        document.documentElement.style.setProperty('--bg1', lightenColor(bg, 8));
        document.documentElement.style.setProperty('--bg2', lightenColor(bg, 16));
        document.documentElement.style.setProperty('--bg3', lightenColor(bg, 24));
        document.documentElement.style.setProperty('--brd', lightenColor(bg, 30));
      }
      if (inp.dataset.var === '--t1') {
        document.documentElement.style.setProperty('--t2', dimColor(inp.value, 0.6));
        document.documentElement.style.setProperty('--t3', dimColor(inp.value, 0.4));
      }
      document.documentElement.removeAttribute('data-theme');
      currentTheme = 'custom';
      // Save custom colors
      const colors = {};
      picker.querySelectorAll('.theme-color-input').forEach(i => { colors[i.dataset.var] = i.value; });
      DB.setKey('themeCustomColors', colors);
      DB.setKey('theme', 'custom');
    });
  });
}

// Color utility: lighten hex color
function lightenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (num >> 16) + amount);
  const g = Math.min(255, ((num >> 8) & 0x00FF) + amount);
  const b = Math.min(255, (num & 0x0000FF) + amount);
  return `#${(1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)}`;
}

// Color utility: dim color by factor
function dimColor(hex, factor) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.round((num >> 16) * factor);
  const g = Math.round(((num >> 8) & 0x00FF) * factor);
  const b = Math.round((num & 0x0000FF) * factor);
  return `#${(1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)}`;
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
    const m = { channels: 'pnChannels', plaza: 'pnPlaza', peers: 'pnPeers', saved: 'pnSaved', dht: 'pnDht', net: 'pnNet', admin: 'pnAdmin' };
    document.getElementById(m[t.dataset.t]).classList.add('on');
    if (t.dataset.t === 'net') setTimeout(drawNet, 60);
    if (t.dataset.t === 'admin') { refreshAdmin(); setAdminAlert(false); }
    if (t.dataset.t === 'saved') refreshSaved();
    if (t.dataset.t === 'plaza') refreshPlaza();
  });
});

// Input
const mIn = document.getElementById('mIn');
function doSend() { const t = mIn.value.trim(); if (!t) return; N.sendChat(t, currentReply); mIn.value = ''; mIn.style.height = 'auto'; clearReply(); }
document.getElementById('sBtn').addEventListener('click', doSend);
mIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
mIn.addEventListener('input', () => {
  mIn.style.height = 'auto'; mIn.style.height = Math.min(mIn.scrollHeight, 80) + 'px';
  // Send typing indicator
  if (mIn.value.trim() && N.id) N.sendTyping(N.chMgr.current);
  // Mention autocomplete
  const v = mIn.value; const atIdx = v.lastIndexOf('@');
  if (atIdx >= 0 && atIdx === v.length - 1 || (atIdx >= 0 && !v.slice(atIdx).includes(' '))) {
    const q = v.slice(atIdx + 1);
    if (q.length >= 0) showMentionList(q); else { const ml = document.getElementById('mentionList'); if (ml) ml.style.display = 'none'; }
  } else { const ml = document.getElementById('mentionList'); if (ml) ml.style.display = 'none'; }
});

// File attach — now through attach menu
document.getElementById('attachBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleAttachMenu(); });
document.querySelectorAll('#attachMenu .attach-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAttachMenu();
    const act = item.dataset.act;
    if (act === 'image') document.getElementById('fileIn').click();
    else if (act === 'poll') togglePollCreate();
    else if (act === 'emoji') { _emojiTarget = 'mIn'; toggleEmojiPicker(); }
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
  if (!e.target.closest('#plazaAttachBtn') && !e.target.closest('#plazaAttachMenu')) {
    const pm = document.getElementById('plazaAttachMenu');
    if (pm) pm.style.display = 'none';
  }
  if (!e.target.closest('.emoji-picker') && !e.target.closest('.attach-item[data-act="emoji"]') && !e.target.closest('.attach-item[data-act="plaza-emoji"]')) document.getElementById('emojiPicker').style.display = 'none';
});

// Poll creation
document.getElementById('pollAddOpt')?.addEventListener('click', () => { if (_pollOptions.length < 6) { _pollOptions.push(''); renderPollOptions(); } });
document.getElementById('pollSend')?.addEventListener('click', sendPollFromUI);
document.getElementById('pollCreateClose')?.addEventListener('click', () => { document.getElementById('pollCreate').style.display = 'none'; });

// Channel topic click
document.getElementById('chTopic')?.addEventListener('click', editTopic);

// Channel stats
document.getElementById('chStatsBtn')?.addEventListener('click', showChannelStats);

// Global search
document.getElementById('globalSearchToggle')?.addEventListener('click', openGlobalSearch);

// Share channel link
document.getElementById('shareChBtn')?.addEventListener('click', () => {
  const ch = N.chMgr?.current || 'general';
  copyLink(getChannelLink(ch));
});

// Theme toggle
document.getElementById('themeBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openThemePicker();
});

// Plaza post composer
document.getElementById('plazaAttachBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const m = document.getElementById('plazaAttachMenu');
  m.style.display = m.style.display === 'none' ? '' : 'none';
});
document.querySelectorAll('#plazaAttachMenu .attach-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('plazaAttachMenu').style.display = 'none';
    const act = item.dataset.act;
    if (act === 'plaza-image') document.getElementById('plazaFileIn').click();
    else if (act === 'plaza-emoji') { _emojiTarget = 'plazaPostInput'; toggleEmojiPicker(); }
  });
});
document.getElementById('plazaFileIn')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  compressImage(file, 300, 0.5, (dataUrl) => {
    _plazaPostImage = dataUrl;
    const prev = document.getElementById('plazaImgPreview');
    prev.style.display = '';
    prev.innerHTML = `<div style="padding:6px 10px;"><img src="${dataUrl}" style="max-height:80px;border-radius:6px;"><span style="font-size:10px;color:var(--t3);cursor:pointer;margin-left:8px;vertical-align:top;" id="plazaImgRm">✕</span></div>`;
    document.getElementById('plazaImgRm')?.addEventListener('click', () => {
      _plazaPostImage = null;
      prev.style.display = 'none';
      prev.innerHTML = '';
    });
  });
  e.target.value = '';
});
document.getElementById('plazaPostSend')?.addEventListener('click', () => {
  const input = document.getElementById('plazaPostInput');
  const text = input?.value?.trim();
  if (!text && !_plazaPostImage) return;
  N.sendSocialPost(text, _plazaPostImage);
  input.value = '';
  input.style.height = 'auto';
  _plazaPostImage = null;
  const prev = document.getElementById('plazaImgPreview');
  if (prev) { prev.style.display = 'none'; prev.innerHTML = ''; }
  refreshPlazaFeed();
});
document.getElementById('plazaPostInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('plazaPostSend')?.click(); }
});
document.getElementById('plazaPostInput')?.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 80) + 'px';
});
// Close theme picker on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme-picker') && !e.target.closest('#themeBtn')) {
    const picker = document.getElementById('themePicker');
    if (picker) picker.remove();
  }
});

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

  // URL routing: read hash and navigate
  handleUrlRoute();

  setInterval(ui, 3000);
}

// ═══ URL ROUTING ═══
// Format: #channel or #channel/msgId
// general channel = no hash (clean URL)
function handleUrlRoute() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;

  const parts = hash.split('/');
  const first = decodeURIComponent(parts[0]).toLowerCase().replace(/[^a-z0-9_-]/g, '');

  // Plaza deep link: #plaza/postId
  if (first === 'plaza') {
    const postId = parts[1] ? decodeURIComponent(parts[1]) : null;
    // Switch to Plaza tab
    document.querySelectorAll('.stab').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.spanel').forEach(x => x.classList.remove('on'));
    const plazaTab = document.querySelector('.stab[data-t="plaza"]');
    if (plazaTab) plazaTab.classList.add('on');
    document.getElementById('pnPlaza')?.classList.add('on');
    refreshPlaza();
    if (postId) {
      setTimeout(() => {
        const postEl = document.querySelector(`.live-post[data-postid="${CSS.escape(postId)}"]`);
        if (postEl) {
          postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          postEl.style.outline = '2px solid var(--cyan)';
          setTimeout(() => { postEl.style.outline = ''; }, 3000);
        }
      }, 300);
    }
    return;
  }

  const channel = first;
  const msgId = parts[1] ? decodeURIComponent(parts[1]) : null;

  if (channel) {
    switchChannel(channel, true);
  }
  if (msgId) {
    scrollToMessage(msgId);
  }
}

function scrollToMessage(msgId) {
  // Try immediately, then retry a few times (messages may still be rendering)
  let attempts = 0;
  const tryScroll = () => {
    const msg = document.querySelector(`.m[data-mid="${CSS.escape(msgId)}"]`);
    if (msg) {
      msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      msg.style.outline = '2px solid var(--cyan)';
      msg.style.transition = 'outline 0.3s';
      setTimeout(() => { msg.style.outline = ''; }, 3000);
      return true;
    }
    if (++attempts < 10) setTimeout(tryScroll, 300);
    return false;
  };
  setTimeout(tryScroll, 200);
}

// Get shareable link for a channel
function getChannelLink(channel) {
  const base = window.location.origin + window.location.pathname;
  if (!channel || channel === 'general') return base;
  return `${base}#${encodeURIComponent(channel)}`;
}

// Get shareable link for a specific message
function getMessageLink(channel, msgId) {
  const base = window.location.origin + window.location.pathname;
  const ch = (!channel || channel === 'general') ? '' : encodeURIComponent(channel);
  if (!ch) return `${base}#general/${encodeURIComponent(msgId)}`;
  return `${base}#${ch}/${encodeURIComponent(msgId)}`;
}

// Copy link to clipboard with toast feedback
async function copyLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    showToastSimple('🔗 Link copied!');
  } catch (_) {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showToastSimple('🔗 Link copied!');
  }
}

// Simple toast (no channel tracking)
function showToastSimple(text) {
  const box = document.getElementById('toastBox');
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="toast-icon">✓</span><div class="toast-body"><div class="toast-text">${esc(text)}</div></div>`;
  box.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 2500);
}

// Back/forward button support
window.addEventListener('hashchange', () => {
  if (N.id) handleUrlRoute(); // only if initialized
});

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
document.addEventListener('click', () => { if (Date.now() - _popupCooldown > 200) closeActionPopup(); });

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
