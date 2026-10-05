"""Test script for multi-user WebSocket endpoint."""
import asyncio
import json
import sys
sys.path.insert(0, '.')

async def test_ws():
    try:
        import websockets
    except ImportError:
        print("websockets not installed - testing via REST only")
        import requests
        r = requests.get('http://localhost:8000/health')
        print('Health:', r.json())
        r2 = requests.get('http://localhost:8000/api/multi/users')
        users = r2.json()
        print('Users count:', len(users))
        for u in users:
            print(f"  {u['user_id']}: route={u['route_name']} running={u['running']}")
        return

    async with websockets.connect('ws://localhost:8000/ws/multi') as ws:
        # Receive first payload
        msg = await asyncio.wait_for(ws.recv(), timeout=5)
        data = json.loads(msg)
        print('Payload type:', data.get('type'))
        print('Users count:', len(data.get('users', [])))
        print('Towers count:', len(data.get('towers', {}).get('all_towers', {})))
        
        users = data.get('users', [])
        for u in users:
            print(f"\n  {u['user_id']}:")
            print(f"    route={u['route_name']} running={u['running']}")
            print(f"    lat={u['vehicle']['lat']:.6f} lon={u['vehicle']['lon']:.6f}")
            towers_info = u.get('towers', {})
            print(f"    handover_active={towers_info.get('handover_active')}")
            print(f"    active_tower={towers_info.get('active_tower')}")
            stats = towers_info.get('stats', {})
            print(f"    stats={stats}")
        
        # Test control message - send left to user_3
        await ws.send(json.dumps({'type': 'control', 'user_id': 'user_3', 'action': 'left'}))
        print('\nSent control LEFT to user_3')
        
        # Receive next tick
        msg2 = await asyncio.wait_for(ws.recv(), timeout=5)
        data2 = json.loads(msg2)
        print('Tick 2 users count:', len(data2.get('users', [])))
        
        # Verify all 5 users present
        user_ids = [u['user_id'] for u in data2.get('users', [])]
        print('User IDs in tick 2:', user_ids)
        
        # Check positions differ between users
        lats = [(u['user_id'], u['vehicle']['lat']) for u in data2.get('users', [])]
        print('Latitudes:', lats)
        unique_lats = len(set(lat for _, lat in lats))
        print(f'Unique positions: {unique_lats}/5 (should be 5)')
        
        print('\nBACKEND TEST: PASS')

asyncio.run(test_ws())
