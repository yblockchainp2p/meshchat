<div align="center">

# 🕸️ MeshChat

**Fully decentralized, peer-to-peer encrypted chat & social platform — no servers, no accounts, no tracking.**

Built entirely with WebRTC, running in your browser. Your messages travel directly between peers through a self-organizing mesh network.

[**Try it live →**](https://yblockchainp2p.github.io/meshchat/)

![Version](https://img.shields.io/badge/Version-1.2.0-22d3ee?style=flat-square)
![P2P](https://img.shields.io/badge/P2P-WebRTC-22d3ee?style=flat-square)
![E2E](https://img.shields.io/badge/Encryption-E2E%20AES--256-10b981?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)
![Zero](https://img.shields.io/badge/Dependencies-Zero-a78bfa?style=flat-square)
![ActionLog](https://img.shields.io/badge/Sync-ActionLog%20Chain-ef4444?style=flat-square)

</div>

---

## What is MeshChat?

MeshChat is a **serverless chat & social platform** where every user is both a client and a relay node. It combines the best of WhatsApp (encrypted DMs, read receipts), Twitter/X (public posts, likes, sharing), Instagram (stories, profile photos), Telegram (channels, polls, pinned messages), and Discord (channels, threads, roles, emoji) — all running peer-to-peer in your browser.

When you open MeshChat, your browser generates a unique cryptographic identity. You connect to nearby peers via WebRTC data channels, and the mesh self-organizes. Every action — messages, likes, deletes, edits — is recorded in a unified **ActionLog** and synchronized across all peers using a blockchain-inspired epoch chain.

### Why MeshChat?

- **No sign-up.** Pick a name, join instantly.
- **No server dependency.** A bootstrap node only helps peers discover each other — it never sees your messages.
- **Censorship-resistant.** No single point of failure. Data lives on every peer.
- **Fully transparent.** Every line of code is right here. No build step, no framework, no dependencies.
- **Consistent sync.** ActionLog ensures all peers converge to the same state, regardless of join/leave timing.

---

## Architecture: ActionLog Chain

MeshChat v1.2.0 introduces a unified event ledger inspired by blockchain principles.

### The Problem (pre-v1.2.0)

Every feature (messages, posts, likes, deletes, reactions, pins...) had its own sync mechanism. When a peer went offline and came back, deleted items could resurrect, likes could be lost, and posts could duplicate. Each fix introduced new edge cases — it was an endless game of whack-a-mole.

### The Solution: Single Source of Truth

**Every mutation is an Action.** A message, a like, a delete, a pin — they're all entries in one ordered log. State is derived from the log, not stored separately.

```
Action {
  id          — unique identifier
  type        — msg | edit | delete | post | like | reaction | story | pin | profile | poll-vote | ...
  channel     — which channel/conversation
  targetId    — what this action affects (for edits, deletes, likes)
  senderId    — who performed it
  data        — type-specific payload
  ts          — wall clock timestamp
  lamport     — logical clock (causal ordering)
  epoch       — time bucket for block grouping
  sig         — ECDSA signature
}
```

### How Sync Works

```
Peer A connects to Peer B:

A: "My Lamport clock is at 847"
B: "Mine is at 1203 — here are actions 848-1203"
A: merges actions → rebuilds state → UI updates

No tombstones needed. Delete is just another action.
A delete action in the log permanently overrides its target.
```

### Epoch Blocks

Every 30 seconds, each peer closes a "block" — a hash of all actions in that epoch. Blocks enable efficient sync: peers compare block hashes, and only exchange data where they differ. A 15-second delay before closing ensures late-arriving actions are included.

### Dependency Resolution

Actions with `targetId` (edits, deletes, likes, reactions) depend on the target action existing first. If a like arrives before the post it references, it enters an **orphan queue** and is applied automatically once the dependency arrives via sync.

### Deterministic State

All peers sort actions by `lamport → timestamp → senderId`. This produces identical ordering regardless of when or in what order actions were received. State is rebuilt from this sorted log, guaranteeing convergence across all peers.

---

## Features

### 💬 Communication
- **Public channels** with topics, pinned messages, and broadcast mode
- **Direct messages** with E2E encryption (ECDH + AES-256-GCM)
- **Read receipts** — ✓ sent, ✓✓ delivered, ✓✓ blue = read (DM only)
- **Typing indicator** — "Alice is typing..." with animated dots
- **Message reactions** — 👍 😂 ❤️ 🔥 😮 👎 with toggle
- **Replies** — quote-reply with visual thread
- **Forwarding** — forward messages across channels
- **Editing & deleting** — edit your own messages, admins can delete any
- **Polls** — multi-option polls with real-time vote tracking
- **Threads** — Slack-style reply chains with "N replies" counter
- **File sharing** — images sent directly P2P with torrent-style distribution

### 🏛️ Plaza (Social Feed)
- **Posts** — share text + images, Twitter/X style feed
- **Likes** — heart reactions with real-time count
- **Share to channel** — share posts as interactive cards with "View in Plaza" navigation
- **Copy Link** — deep-linkable post URLs (`#plaza/postId`)
- **Profile wall** — each user's posts visible on their profile

### 📖 Stories
- **24-hour stories** — text + image, disappear automatically
- **Spinning neon ring** — animated border per user, unique neon color
- **Story viewer** — full-screen overlay, tap to advance
- **Background colors** — 7 color presets

### 👤 Profiles & Identity
- **Cryptographic identity** — ECDSA keypair generated on first visit, stored in IndexedDB
- **Profile photos** — upload avatar image, compressed for P2P gossip
- **Bio** — 150 character description
- **Status** — Online / Do Not Disturb / AFK
- **Emoji avatar** — alternative to photo
- **Profile stats** — message count, active channels, last seen
- **Badges** — 🛡️ Admin, ⚔️ Mod, 🏆 OG, ⚡ Active, 🆕 New

### 🔍 Discovery
- **Trending channels** — most active channels in the last hour
- **Channel statistics** — hourly activity chart, top contributors
- **Global search** — full-text search across all channels
- **Shareable links** — `#channel` and `#channel/msgId` deep links

### 🎨 Customization
- **7 theme presets** — Midnight, Light, Nord, Dracula, Ocean, Ember, Matrix
- **Custom colors** — pick your own background, accent, and text colors
- **Full emoji picker** — 500+ emoji across 8 categories
- **Notification sounds** — audio alerts with mute support per channel
- **Unread badges** — numbered counts per channel

### 🛡️ Moderation
- **Admin/mod system** with reports, bans, and role management
- **Persistent report queue** — reports delivered when admin comes online
- **Banned words filter** — single word or combo detection
- **Media moderation** — images require admin approval before display
- **Slow mode** — configurable per-channel message rate limit
- **Broadcast mode** — admin-only channels for announcements
- **Pinned messages** — up to 3 pins per channel
- **Native ad system** — admin-managed ads that blend into the feed as natural content

### 🔐 Security
- **ECDSA P-256 signatures** on every action
- **ECDH key exchange** for DM encryption (AES-256-GCM)
- **Lamport clocks** for causal ordering
- **Trust scoring** — peers earn trust through uptime, relay behavior, and consistency
- **Community banning** — threshold-based vote system
- **Anti-flood** — rate limiting based on trust score
- **Gossip protocol** with dedup cache and TTL-based hop limits
- **Kademlia DHT** for scalable peer discovery

### 📡 Network Resilience
- **Peer cache** — reconnect to known peers when bootstrap is down
- **P2P signaling relay** — peers relay WebRTC signaling for each other
- **Wake detection** — automatic reconnect after device sleep or network change
- **Torrent-style file distribution** — files are chunked, cached, and served by any peer who has them
- **PWA support** — installable, works offline, network-first caching

---

## How It Works

```
┌──────────┐    WebRTC     ┌──────────┐    WebRTC     ┌──────────┐
│  Peer A  │◄────────────►│  Peer B  │◄────────────►│  Peer C  │
│ (Browser)│  Data Channel │ (Browser)│  Data Channel │ (Browser)│
└──────────┘               └──────────┘               └──────────┘
     │                          │                          │
     └────────WebSocket─────────┘                          │
              (signaling only)                             │
          ┌──────────────┐                                 │
          │  Bootstrap   │◄────────WebSocket────────────────┘
          │  (signaling) │
          └──────────────┘
```

**Connection flow:**
1. **Join** — pick a name, MeshChat generates your ECDSA + ECDH keypair
2. **Signal** — bootstrap WebSocket exchanges ICE candidates between peers
3. **Connect** — WebRTC data channels open directly between browsers
4. **Handshake** — peers exchange keys, genesis, moderation data, and ActionLog sync cursors
5. **Chain sync** — peers compare Lamport clocks and exchange missing actions
6. **Live** — new actions are gossiped in real-time; state is rebuilt incrementally

**Data flow for a message:**
1. User types → `sendChat()` creates an Action with type `msg`
2. Action is signed with ECDSA, added to local ActionLog
3. Action is gossiped to all connected peers
4. Each peer adds it to their ActionLog → StateBuilder applies it incrementally → UI updates
5. Every 30s, the epoch block closes and hash is computed
6. When a new peer joins, they sync missing actions by comparing Lamport clocks

**A bootstrap server** handles only WebSocket signaling — exchanging ICE candidates so peers can establish direct WebRTC connections. It never sees message content. The server also caches the network genesis for faster reconnection.

---

## Getting Started

### Just Use It

Visit [**yblockchainp2p.github.io/meshchat**](https://yblockchainp2p.github.io/meshchat/) — pick a name and start chatting.

### Self-Host

```bash
git clone https://github.com/yblockchainp2p/meshchat.git
cd meshchat
python3 -m http.server 8080
# Open http://localhost:8080 in two tabs to test P2P
```

No npm. No build step. No dependencies. Just HTML, CSS, and JavaScript.

---

## File Structure

```
meshchat/
├── index.html       → Page layout, modals, sidebar, input bars
├── core.js          → Crypto identity (ECDSA/ECDH), IndexedDB, Kademlia DHT,
│                       Gossip protocol, Lamport clock, Trust engine,
│                       Moderation engine, File transfer (chunked P2P),
│                       Network genesis, ActionLog, BlockChain, StateBuilder
├── node.js          → Node class: WebRTC connections, ActionLog protocol,
│                       chain sync, handshake, gossip routing, DM encryption,
│                       file sharing, moderation actions, all public API
├── ui.js            → All rendering: messages, Plaza feed, stories,
│                       emoji picker, themes, threads, search, statistics,
│                       profile editor, share cards, notifications, admin panel
├── style.css        → Dark theme, 7 presets, responsive, animations
├── sw.js            → Service worker: network-first caching, PWA support
├── manifest.json    → PWA manifest
├── server.py        → Bootstrap signaling server (separate deployment)
└── README.md        → This file
```

### Core Classes (core.js)

| Class | Purpose |
|-------|---------|
| `CryptoId` | ECDSA signing + ECDH key exchange |
| `DB` | IndexedDB wrapper (kv, messages, actions, blocks, peers, fileCache) |
| `RT` | Kademlia routing table (160-bit, K=20) |
| `Gossip` | Fanout-based message propagation with dedup |
| `LamportClock` | Logical clock for causal ordering |
| `MsgStore` | Legacy message store (kept for compatibility) |
| `ChannelMgr` | Channel switching, DM channel naming |
| `TrustEngine` | Per-peer trust scoring, rate limiting, community bans |
| `ModerationEngine` | Admin/mod system, reports, media approval, banned words, ads |
| `FileTransfer` | Chunked P2P file transfer with seeder tracking |
| `NetworkGenesis` | Network identity, conflict resolution (more peers wins) |
| `ActionLog` | **Unified event ledger** — all mutations as ordered actions |
| `BlockChain` | **Epoch-based block closing** with SHA-256 hashing |
| `StateBuilder` | **Derives UI state from ActionLog** — messages, posts, stories, reactions, pins, profiles |

---

## URL Routing

| URL | Destination |
|-----|-------------|
| `meshchat/` | #general channel |
| `meshchat/#btc` | #btc channel |
| `meshchat/#btc/msgId` | Specific message in #btc |
| `meshchat/#plaza` | Plaza social feed |
| `meshchat/#plaza/postId` | Specific Plaza post |

---

## Ad System

MeshChat includes a built-in ad system managed by the network admin. Ads are distributed P2P alongside other network data — no third-party ad servers required.

**Ad types:**
- **Text** — simple text with optional link
- **Banner** — image with clickable link
- **Script** — third-party ad scripts (Adsterra, etc.) loaded in sandboxed iframes
- **HTML** — raw HTML content

**Placements:**
- **Channel messages** — appears as a native message from "📢 MeshChat"
- **Plaza feed** — appears as a native post between user posts
- **Pending media** — shown while images await admin approval

Ads blend into the content naturally — no "SPONSORED" labels, no separate boxes. They look like regular messages and posts.

---

## Contributing

MeshChat is fully open source. Contributions welcome!

### Development Guidelines

1. **Keep it serverless.** The bootstrap server is only for signaling.
2. **Keep it single-page.** Core files, no build step, no framework.
3. **Test on mobile.** Every feature must work with touch.
4. **ActionLog first.** All state mutations must go through `_emit()` → ActionLog → StateBuilder.

### Running Locally

```bash
git clone https://github.com/yblockchainp2p/meshchat.git
cd meshchat
python3 -m http.server 8080
# Open http://localhost:8080 in two browser tabs to test P2P
```

---

## Roadmap

- 🔌 Full peer-to-peer signaling (completely bootstrap-free)
- 🛡️ PoW anti-spam (Sybil attack prevention)
- 🔒 Private channels (invite-only with shared key)
- 🎙️ Voice messages
- 🧅 Onion routing for enhanced privacy
- 📊 Advanced block explorer / network visualizer
- 🔄 Merkle tree-based efficient state diff sync

---

## Distribution

| Platform | How |
|----------|-----|
| **GitHub Pages** | Fork → enable Pages → done |
| **Netlify / Vercel** | Drag and drop the folder |
| **IPFS** | `ipfs add -r meshchat/` |
| **USB drive** | Copy the files, open `index.html` |
| **Local network** | `python3 -m http.server` |

No npm. No build step. No dependencies.

---

## License

MIT — do whatever you want with it.

---

<div align="center">

**No accounts. No servers. No tracking. Just people talking to people.**

**Every action is a link in the chain. Every peer is a node in the mesh.**

[Try MeshChat →](https://yblockchainp2p.github.io/meshchat/)

</div>
