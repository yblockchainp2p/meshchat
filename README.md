<div align="center">

# 🕸️ MeshChat

**Fully decentralized, peer-to-peer encrypted chat & social platform — no servers, no accounts, no tracking.**

Built entirely with WebRTC, running in your browser. Your messages travel directly between peers through a self-organizing mesh network.

[**Try it live →**](https://yblockchainp2p.github.io/meshchat/)

![P2P](https://img.shields.io/badge/P2P-WebRTC-22d3ee?style=flat-square)
![E2E](https://img.shields.io/badge/Encryption-E2E%20AES--256-10b981?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)
![Zero](https://img.shields.io/badge/Backend-Zero%20dependency-a78bfa?style=flat-square)

</div>

---

## What is MeshChat?

MeshChat is a **serverless chat & social platform** where every user is both a client and a relay node. It combines the best of WhatsApp (encrypted DMs, read receipts), Twitter/X (public posts, likes, sharing), Instagram (stories, profile photos), Telegram (channels, polls, pinned messages), and Discord (channels, threads, roles, emoji) — all running peer-to-peer in your browser.

When you open MeshChat, your browser generates a unique cryptographic identity. You connect to nearby peers via WebRTC data channels, and the mesh self-organizes. Everything is end-to-end encrypted for DMs and cryptographically signed for public channels.

### Why MeshChat?

- **No sign-up.** Pick a name, join instantly.
- **No server dependency.** The bootstrap node only helps peers discover each other — it never sees your messages.
- **Censorship-resistant.** No single point of failure.
- **Fully transparent.** Every line of code is right here.

---

## Features

### 💬 Communication
- **Public channels** with topics, pinned messages, and broadcast mode
- **Direct messages** with E2E encryption (ECDH + AES-256-GCM)
- **Read receipts** — ✓ sent, ✓✓ delivered, ✓✓ blue = read (DM only)
- **Typing indicator** — "Alice is typing..." with animated dots
- **Message reactions, replies, forwarding, editing, deleting**
- **Polls** — multi-option polls with real-time vote tracking
- **Threads** — Slack-style reply chains, "3 replies" counter, side panel
- **File sharing** — images sent directly P2P

### 🏛️ Plaza (Social Feed)
- **Posts** — share text + images, Twitter/X style feed
- **Likes** — heart reactions on posts
- **Share** — share posts to channels as ephemeral cards (15s auto-delete)
- **Copy Link** — deep-linkable post URLs (`#plaza/postId`)
- **Profile wall** — each user's posts visible on their profile

### 📖 Stories
- **24-hour stories** — text + image, disappear automatically
- **Spinning neon ring** — animated border per user, unique neon color
- **Story viewer** — full-screen overlay, tap to advance
- **Background colors** — choose from 7 color presets

### 👤 Profiles & Identity
- **Profile photos** — upload avatar image, compressed for P2P
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
- **Banned words filter, media moderation, slow mode**
- **Broadcast mode** — admin-only channels for announcements
- **Pinned messages** — up to 3 pins per channel

### 🔐 Security
- **Ed25519 signatures** on every message
- **ECDH key exchange** for DM encryption
- **Lamport clocks** for message ordering
- **Trust scoring** based on peer behavior
- **Gossip protocol** with dedup cache and hop limits
- **Kademlia DHT** for peer discovery

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

1. **Join** — pick a name, MeshChat generates your ECDSA/ECDH keypair
2. **Signal** — bootstrap WebSocket exchanges ICE candidates between peers
3. **Connect** — WebRTC data channels open directly between browsers
4. **Handshake** — peers exchange keys, routing tables, profiles, stories, pins
5. **Chat** — messages are signed, timestamped, and gossiped through the mesh
6. **DM** — shared secret via ECDH, encrypted with AES-256-GCM

---

## Getting Started

### Just Use It

Visit [**yblockchainp2p.github.io/meshchat**](https://yblockchainp2p.github.io/meshchat/) — pick a name and start chatting.

### Self-Host

```bash
git clone https://github.com/yblockchainp2p/meshchat.git
cd meshchat
python3 -m http.server 8080
# Open http://localhost:8080
```

---

## File Structure

```
meshchat/
├── index.html      → Layout, modals, sidebar, input bars
├── core.js         → Crypto, DB, DHT, Gossip, Trust, Moderation, Genesis
├── node.js         → Node class: WebRTC, messaging, social features,
│                      profiles, stories, posts, pins, typing, receipts,
│                      badges, broadcast, pending queue
├── ui.js           → All rendering: messages, Plaza feed, stories,
│                      emoji picker, themes, threads, search, stats,
│                      profile editor, share cards, notifications
├── style.css       → Dark theme, 7 presets, responsive, animations
└── README.md       → This file
```

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

## Contributing

MeshChat is fully open source. Contributions welcome!

### Development Guidelines

1. **Keep it serverless.** No backend dependencies.
2. **Keep it single-page.** Four files, no build step, no framework.
3. **Test on mobile.** Every feature must work with touch.
4. **Backward compatible.** New peers must talk to older peers.

### Running Locally

```bash
git clone https://github.com/yblockchainp2p/meshchat.git
cd meshchat
python3 -m http.server 8080
# Open in two tabs to test P2P
```

---

## Roadmap

- 📱 PWA support (offline, installable, push notifications)
- 🔌 Peer-to-peer signaling (bootstrap-free reconnection)
- 🛡️ PoW anti-spam (Sybil attack prevention)
- 💬 Offline DM relay (store-and-forward via peers)
- 🔒 Private channels (invite-only with shared key)
- 🎙️ Voice messages
- 🧅 Onion routing for enhanced privacy

---

## Distribution

| Platform | How |
|----------|-----|
| **GitHub Pages** | Fork → enable Pages → done |
| **Netlify / Vercel** | Drag and drop |
| **IPFS** | `ipfs add -r meshchat/` |
| **USB drive** | Copy 4 files, open in browser |
| **Local network** | `python3 -m http.server` |

No npm. No build step. No dependencies. HTML, CSS, JavaScript.

---

## License

MIT — do whatever you want with it.

---

<div align="center">

**No accounts. No servers. No tracking. Just people talking to people.**

[Try MeshChat →](https://yblockchainp2p.github.io/meshchat/)

</div>
