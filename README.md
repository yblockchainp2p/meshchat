<div align="center">

# 🕸️ MeshChat

**Fully decentralized, peer-to-peer encrypted chat — no servers, no accounts, no tracking.**

Built entirely with WebRTC, running in your browser. Your messages travel directly between peers through a self-organizing mesh network.

[**Try it live →**](https://yblockchainp2p.github.io/meshchat/)

![P2P](https://img.shields.io/badge/P2P-WebRTC-22d3ee?style=flat-square)
![E2E](https://img.shields.io/badge/Encryption-E2E%20AES--256-10b981?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)
![Zero](https://img.shields.io/badge/Backend-Zero%20dependency-a78bfa?style=flat-square)

</div>

---

## What is MeshChat?

MeshChat is a **serverless chat application** where every user is both a client and a relay node. Messages propagate through the network using gossip protocol and a Kademlia-based DHT — no central server stores or routes your conversations.

When you open MeshChat, your browser generates a unique cryptographic identity (ECDSA + ECDH keys). You connect to nearby peers via WebRTC data channels, and the mesh self-organizes. If peer A can't reach peer C directly, peer B relays the message automatically. Everything is end-to-end encrypted for DMs and cryptographically signed for public channels.

### Why MeshChat?

- **No sign-up.** Pick a name, join.
- **No server dependency.** The bootstrap node only helps peers discover each other — it never sees your messages.
- **Censorship-resistant.** No single point of failure. The network works as long as peers exist.
- **Fully transparent.** Every line of code is right here.

---

## Features

### Communication
- **Public channels** — Create unlimited topic-based channels (`#general`, `#gaming`, `#dev`)
- **Direct messages** — End-to-end encrypted with ECDH key exchange + AES-256-GCM
- **Message reactions** — React to any message with emoji
- **Polls** — Create multi-option polls, see real-time results
- **Message replies** — Thread-style reply to specific messages
- **Message forwarding** — Forward messages across channels
- **File sharing** — Send images, documents, and files directly P2P
- **Link previews** — URLs display domain and path preview cards

### Emoji & Expression
- **Full emoji picker** — 500+ emoji across 8 categories (Smileys, Hands, Hearts, Animals, Food, Travel, Objects, Symbols)
- **Inline reactions** — Quick react with 👍 😂 ❤️ 🔥 😮 👎
- **Markdown support** — Bold, italic, strikethrough, inline code

### Network & Security
- **Ed25519 signatures** — Every message is cryptographically signed and verified
- **Gossip protocol** — Messages propagate through the mesh with configurable fanout
- **Kademlia DHT** — Distributed hash table for peer discovery beyond direct connections
- **Lamport clocks** — Logical timestamps for consistent message ordering
- **Trust scoring** — Reputation system tracks peer behavior over time
- **Network visualization** — Real-time mesh topology map with connection health metrics

### Organization
- **Channel topics** — Set descriptions for each channel
- **Bookmarks** — Save important messages, access them from the Saved panel
- **Global search** — Full-text search across all channels and DMs
- **Channel search** — Filter messages within the current channel
- **Unread badges** — Numbered badge counts per channel
- **Notification sounds** — Audio alerts for new messages (respects mute settings)
- **Mute channels** — Silence notifications per channel

### Moderation
- **Admin system** — Network creator becomes admin with full moderation powers
- **Moderator roles** — Admins can promote/demote moderators
- **Report system** — Users can report messages and peers
- **Persistent report queue** — Reports are queued and delivered when admin comes online
- **Ban voting** — Community-driven ban decisions
- **Banned words filter** — Admin-configurable word filter with combinations
- **Media moderation** — Images require admin approval before display
- **Slow mode** — Rate-limit messages per channel

### Mobile
- **Fully responsive** — Works on phones, tablets, and desktop
- **Touch-optimized** — Long-press for message actions, swipe-friendly navigation
- **Mobile drawer** — Collapsible sidebar with unread indicators
- **Viewport handling** — Proper keyboard avoidance on mobile browsers

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
          │  (signaling) │   (helps peers find each other)
          └──────────────┘
```

1. **Join** — You pick a name. MeshChat generates your ECDSA/ECDH keypair and derives your unique node ID.
2. **Signal** — Your browser connects to the bootstrap WebSocket *only* to exchange ICE candidates with other peers.
3. **Connect** — WebRTC data channels open directly between browsers. The bootstrap is no longer needed.
4. **Handshake** — Peers exchange public keys, routing tables, channel data, and network genesis info.
5. **Chat** — Messages are signed, stamped with Lamport clocks, and gossiped through the mesh.
6. **DM** — Direct messages derive a shared secret via ECDH, then encrypt with AES-256-GCM.

### Gossip Protocol

Public messages use a bounded gossip protocol: each peer forwards messages to `fanout` random neighbors (default: 6), with a hop limit. Duplicate messages are detected and dropped via the gossip cache.

### DHT (Kademlia)

The distributed hash table enables peer discovery beyond direct connections. When you can't reach someone directly, the DHT routes lookup requests through the overlay network based on XOR distance between node IDs.

### Trust Engine

Every peer maintains local trust scores based on:
- Connection uptime and stability
- Message verification success rate
- Report and ban vote history

---

## Getting Started

### Option 1: Just Use It

Visit [**yblockchainp2p.github.io/meshchat**](https://yblockchainp2p.github.io/meshchat/) — pick a name and start chatting. That's it.

### Option 2: Self-Host (Static Files)

MeshChat is just static HTML/CSS/JS. Host it anywhere:

```bash
git clone https://github.com/yblockchainp2p/meshchat.git
cd meshchat

# Serve with any static file server
python3 -m http.server 8080
# or
npx serve .
# or just open index.html in a browser
```

> **Note:** For peers to discover each other, they need a shared bootstrap WebSocket server. The default configuration points to a public signaling server. To run a fully independent network, you'll need to host your own signaling endpoint and update `CFG.BS_URL` in `core.js`.

---

## File Structure

```
meshchat/
├── index.html      → Main HTML shell — layout, modals, sidebar structure
├── core.js         → Core infrastructure classes:
│                      • CryptoId (ECDSA/ECDH key management)
│                      • DB (IndexedDB persistence layer)
│                      • MsgStore (message storage with channel separation)
│                      • ChannelMgr (channel state management)
│                      • RT / Kademlia DHT (distributed hash table)
│                      • Gossip (bounded gossip with dedup cache)
│                      • LamportClock (logical timestamps)
│                      • TrustEngine (peer reputation scoring)
│                      • ModerationEngine (admin/mod/reports/bans)
│                      • FileTransfer (chunked P2P file transfer)
│                      • NetworkGenesis (network identity + conflict resolution)
│
├── node.js         → Main Node class — the "brain" of each peer:
│                      • WebRTC connection management
│                      • Peer message routing (chat, DM, handshake, etc.)
│                      • Gossip relay + DHT lookups
│                      • Poll system
│                      • Bookmark management
│                      • Admin/mod action handlers
│                      • Pending queue (offline-tolerant report delivery)
│
├── ui.js           → All UI rendering and interaction:
│                      • Message rendering with reactions, polls, link previews
│                      • Channel list with unread badges
│                      • Peer list with trust scores
│                      • Emoji picker (500+ emoji)
│                      • Attach menu (file/poll/emoji)
│                      • Global search overlay
│                      • Bookmark panel
│                      • Network visualization canvas
│                      • Admin panel
│                      • Notification sounds
│                      • Mobile touch handling
│
├── style.css       → All styling — dark theme, responsive layout, animations
└── README.md       → You are here
```

---

## Network Architecture

### Genesis & Network Identity

The first peer to create a network becomes its **genesis admin**. When two separate MeshChat networks meet (peers from network A connect to peers from network B), a deterministic conflict resolution algorithm decides which network's rules survive based on peer count and genesis timestamp.

### Offline Tolerance

MeshChat handles intermittent connectivity gracefully:

- **Message history sync** — When a new peer connects, they receive the channel history from existing peers.
- **Pending admin queue** — Reports, moderation actions, and other admin-targeted messages are queued locally (persisted to IndexedDB) and automatically flushed when an admin/mod peer comes online. Queue items have 24-hour TTL and deduplication.
- **Media approval state** — Approval/rejection decisions propagate via handshake, so new peers don't see stale "pending" states.
- **Slow mode sync** — Rate-limit settings included in handshake data.

### Security Model

| Layer | Mechanism |
|-------|-----------|
| Identity | ECDSA P-256 keypair (generated in browser, never leaves device) |
| Signing | Every message includes an Ed25519 signature verified by recipients |
| DM Encryption | ECDH key agreement → AES-256-GCM (unique shared secret per peer pair) |
| Integrity | Lamport clocks + gossip dedup prevent replay and reordering |
| Trust | Local reputation scores; bad actors get reduced relay priority |

> **Important:** The bootstrap/signaling server only relays ICE candidates (connection metadata). It never sees message content. Once WebRTC connects, the signaling server can go offline and existing peers continue chatting.

---

## Configuration

Key constants are in `core.js` under the `CFG` object:

| Setting | Default | Description |
|---------|---------|-------------|
| `BS_URL` | `wss://...` | Bootstrap WebSocket URL for signaling |
| `FANOUT` | `6` | Gossip fanout — how many peers to relay each message to |
| `MAX_HOPS` | `10` | Maximum gossip hop count |
| `MSG_LIMIT` | `100` | Messages stored per channel |
| `DB_NAME` | `meshchat` | IndexedDB database name |

---

## Contributing

MeshChat is fully open source and contributions are welcome!

### Ways to Contribute

- **Bug reports** — Found something broken? Open an issue with steps to reproduce.
- **Feature requests** — Have an idea? Open an issue and describe the use case.
- **Code contributions** — Fork, branch, and submit a PR.
- **Testing** — Try it on different browsers, devices, and network conditions. Report what you find.
- **Documentation** — Improve this README, add code comments, write guides.

### Development Guidelines

1. **Keep it serverless.** MeshChat's core value is that it works without backend infrastructure. Features that require a central server are out of scope.
2. **Keep it single-page.** The entire app is four files (HTML, CSS, 2x JS). No build step, no bundler, no framework. This is intentional.
3. **Test on mobile.** A significant portion of users are on phones. Every feature must work with touch.
4. **Maintain backward compatibility.** New peers should be able to talk to older peers. Handshake data should be additive, not breaking.

### Running Locally

```bash
git clone https://github.com/yblockchainp2p/meshchat.git
cd meshchat
python3 -m http.server 8080
# Open http://localhost:8080 in two browser tabs to test P2P locally
```

### Reporting Bugs

When reporting bugs, please include:
- Browser and version
- Device type (desktop/mobile)
- Number of peers in the network
- Steps to reproduce
- Console errors (if any)

---

## Roadmap

Upcoming features under consideration:

- 🎨 Theme system (dark/light/custom color schemes)
- 🧵 Threaded conversations (reply chains)
- 📊 Channel statistics (most active hours, top contributors)
- 🔒 Private channels (invite-only with shared key)
- 🎙️ Voice chat (WebRTC audio)
- ⏰ Disappearing messages
- 🏷️ Message tagging (#todo, #important)
- 🎲 In-chat mini-games

---

## Distribution & Hosting

MeshChat is just static files. You can host it anywhere:

| Platform | How |
|----------|-----|
| **GitHub Pages** | Fork → enable Pages → done |
| **Netlify / Vercel** | Drag and drop the folder |
| **IPFS** | `ipfs add -r meshchat/` — fully decentralized hosting |
| **USB drive** | Copy the 4 files, open `index.html` in any browser |
| **Local network** | `python3 -m http.server` — instant LAN chat |
| **Any web server** | Nginx, Apache, Caddy — just serve static files |

No npm, no build step, no dependencies. It's HTML, CSS, and JavaScript — that's it.

### Running Your Own Network

To create a completely independent MeshChat network:

1. Host the static files on your own domain
2. Set up a WebSocket signaling server (any simple WS relay works)
3. Update `CFG.BS_URL` in `core.js` to point to your signaling server
4. Share the URL — everyone who opens it joins your network

---

## License

MIT — do whatever you want with it. See [LICENSE](LICENSE) for details.

---

<div align="center">

**MeshChat is built by the community, for the community.**

No accounts. No servers. No tracking. Just people talking to people.

[Try MeshChat →](https://yblockchainp2p.github.io/meshchat/)

</div>
