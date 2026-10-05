import sys
sys.path.insert(0, '.')
from app.routers import multi_user

print("=== MULTI USER TEST ===")
print(f"Users count: {len(multi_user._multi_users)}")
for uid, u in multi_user._multi_users.items():
    print(f"  {uid}: route={u.route_name} lat={u.lat:.6f} lon={u.lon:.6f} hdg={u.heading:.1f}")

# Advance 10 ticks
print("\nAdvancing 10 ticks...")
for i in range(10):
    for u in multi_user._multi_users.values():
        multi_user._tick_user(u)

print("\nAfter 10 ticks:")
unique_coords = set()
for uid, u in multi_user._multi_users.items():
    unique_coords.add((round(u.lat, 4), round(u.lon, 4)))
    print(f"  {uid}: lat={u.lat:.6f} lon={u.lon:.6f} hdg={u.heading:.1f} pred={u.last_pred.get('predicted_path')} conf={u.last_pred.get('confidence')} ho={u.controller.handover_active} active_tower={u.controller.active_tower_id} tput={u.last_net.get('throughput_mbps')}")

print(f"\nUnique user coordinates: {len(unique_coords)}/5")
assert len(unique_coords) == 5, f"Expected 5 distinct coordinates, got {len(unique_coords)}"
assert len(multi_user._multi_users) == 5, f"Expected 5 users, got {len(multi_user._multi_users)}"

payload = multi_user._build_payload()
assert 'users' in payload, "users missing in payload"
assert 'users_map' in payload, "users_map missing in payload"
assert len(payload['users']) == 5, f"Expected 5 users in payload, got {len(payload['users'])}"
print("Payload schema test: PASS")

stats = multi_user.get_multi_stats()
print(f"Aggregated stats test: active_users={stats['active_users']}, total_ho={stats['total_handovers']}")
assert stats['active_users'] == 5, "Expected 5 active users in stats"

print("\nALL BACKEND STANDALONE TESTS PASSED SUCCESSFULLY!")
