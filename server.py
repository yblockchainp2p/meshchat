"""
MeshChat Bootstrap Server v5 — Signaling + Genesis Cache
Pure signaling server. Network authority lives in P2P genesis system.
Server caches genesis for faster sync but is NOT the source of truth.
Uses only 'websockets' library. Deploy on Render.com.
"""

import asyncio
import json
import logging
import os
from datetime import datetime

import websockets

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('meshchat')

peers = {}
cached_genesis = None


async def broadcast(message, exclude=None):
    for pid, peer in list(peers.items()):
        if pid == exclude:
            continue
        try:
            await peer['ws'].send(message)
        except Exception as e:
            logger.warning(f'Broadcast error to {pid[:12]}: {e}')


async def handler(websocket):
    global cached_genesis
    node_id = None

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get('type')

            if msg_type == 'register':
                node_id = data.get('nodeId')
                username = data.get('username', 'anon')
                if not node_id:
                    continue

                peers[node_id] = {
                    'ws': websocket,
                    'username': username,
                    'nodeId': node_id,
                    'connected_at': datetime.utcnow().isoformat(),
                }

                logger.info(f'+ {username} ({node_id[:12]}...) — Total: {len(peers)}')

                peer_list = [
                    {'nodeId': p['nodeId'], 'username': p['username']}
                    for p in peers.values()
                ]
                response = {'type': 'peers', 'peers': peer_list}
                if cached_genesis:
                    response['cachedGenesis'] = cached_genesis

                await websocket.send(json.dumps(response))

                await broadcast(json.dumps({
                    'type': 'peer-joined',
                    'nodeId': node_id,
                    'username': username,
                }), exclude=node_id)

            elif msg_type == 'signal':
                target_id = data.get('to')
                if target_id and target_id in peers:
                    try:
                        await peers[target_id]['ws'].send(json.dumps({
                            'type': 'signal',
                            'from': data.get('from'),
                            'fromName': data.get('fromName', 'anon'),
                            'signal': data.get('signal'),
                        }))
                    except Exception as e:
                        logger.warning(f'Signal relay error to {target_id[:12]}: {e}')

            elif msg_type == 'genesis-update':
                genesis = data.get('genesis')
                if genesis and isinstance(genesis, dict) and genesis.get('networkId'):
                    if not cached_genesis:
                        cached_genesis = genesis
                        logger.info(f'Genesis cached: {genesis.get("networkId", "?")[:12]}')
                    elif genesis.get('peerCount', 0) >= cached_genesis.get('peerCount', 0):
                        cached_genesis = genesis

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error(f'Handler error: {e}')
    finally:
        if node_id and node_id in peers:
            username = peers[node_id].get('username', '?')
            del peers[node_id]
            logger.info(f'- {username} ({node_id[:12]}...) — Total: {len(peers)}')
            await broadcast(json.dumps({
                'type': 'peer-left',
                'nodeId': node_id,
            }))


async def main():
    port = int(os.environ.get('PORT', 8080))
    logger.info(f'MeshChat Bootstrap v5 starting on port {port}')
    async with websockets.serve(handler, '0.0.0.0', port):
        logger.info(f'Listening on 0.0.0.0:{port}')
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
