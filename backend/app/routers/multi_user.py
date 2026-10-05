"""
routers/multi_user.py
---------------------
Multi-user 5G handover simulation — FIVE independent users.

Every user has an independent:
  - WaypointWalker  (position, route progress, steering offset)
  - TrajectoryPredictor  (consecutive_alignments — no state leakage)
  - TowerController  (full independent handover/beamforming state)
  - Network metrics
  - Handover log  (includes user_id on every entry)

Five users are pre-seeded at startup using all four routes
(user_5 starts ROUTE_A at a mid-route offset).

REST:
  GET    /api/multi/users
  POST   /api/multi/reset

WebSocket:
  /ws/multi  — broadcasts MultiUserUpdate every 500 ms
              — accepts control messages:
                {"type": "control", "user_id": "user_3", "action": "left"|"right"}
"""

import asyncio
import datetime
import json
import math
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from app.services.prediction_engine import TrajectoryPredictor
from app.services.tower_controller import TowerController

# Import shared road infrastructure from simulation router.
# No circular dependency: simulation.py does NOT import multi_user.py.
from app.routers.simulation import (
    ROAD_ROUTES,
    WaypointWalker,
    _bearing,
    _dist_m,
    _smooth_heading,
    _SPEED_MPS,
    _TICK_INTERVAL_S,
)

router = APIRouter()

# ─── Constants ────────────────────────────────────────────────────────────────
_VEHICLE_SPEED_KMH = 30.0
MAX_USERS = 10
_STEER_HEADING_OFFSET = 25.0   # degrees applied for one steer tick
_STEER_DECAY_TICKS    = 6      # how many ticks the steering effect lasts

# ─── Route mapping ────────────────────────────────────────────────────────────
ROUTE_INDEX = {'ROUTE_A': 0, 'ROUTE_B': 1, 'ROUTE_C': 2, 'ROUTE_D': 3, 'ROUTE_E': 4}
ROUTE_DIRECTION = {
    'ROUTE_A': 'EAST',
    'ROUTE_B': 'WEST',
    'ROUTE_C': 'SOUTH',
    'ROUTE_D': 'NORTH',
    'ROUTE_E': 'NORTHEAST',
}


# ─── Per-user session ─────────────────────────────────────────────────────────

@dataclass
class UserSession:
    """All state for one simulated user — completely independent of every other user."""

    user_id: str
    route_name: str
    phone_number: str = ''

    # Simulation control
    running: bool = False

    # Movement — one WaypointWalker per user
    walker: Optional[object] = None

    # Prediction — one TrajectoryPredictor per user (no state leakage)
    predictor: Optional[TrajectoryPredictor] = None

    # Tower controller — one per user (fully independent beamforming state)
    controller: Optional[TowerController] = None

    # Last known position
    lat: float = 0.0
    lon: float = 0.0
    heading: float = 0.0

    # Steering offset (applied for _STEER_DECAY_TICKS ticks)
    _steer_offset: float = 0.0
    _steer_ticks_left: int = 0

    # Last tick outputs
    last_pred: dict = field(default_factory=lambda: {
        'predicted_path': None,
        'confidence': 0.0,
        'distance_to_center': 0.0,
    })
    last_net: dict = field(default_factory=lambda: {
        'latency_ms': 15.0,
        'handover_latency_ms': None,
        'throughput_mbps': 500.0,
    })

    # Counters and log
    tick: int = 0
    handover_log: List[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        ctrl = self.controller
        if ctrl is None:
            tower_snapshot = {
                'handover_active': False,
                'active_tower': None,
                'suppressed_towers': [],
                'all_towers': {},
                'stats': {
                    'total_handovers': 0,
                    'ping_pong_events': 0,
                    'ping_pong_reduction_pct': 0.0,
                },
            }
        else:
            tower_snapshot = ctrl.get_state_snapshot()

        return {
            'user_id': self.user_id,
            'phone_number': self.phone_number,
            'route_name': self.route_name,
            'direction': ROUTE_DIRECTION.get(self.route_name, 'CUSTOM'),
            'running': self.running,
            'tick': self.tick,
            'vehicle': {
                'lat': round(self.lat, 7),
                'lon': round(self.lon, 7),
                'heading': round(self.heading, 1),
                'speed_kmh': _VEHICLE_SPEED_KMH,
            },
            'prediction': {
                'predicted_path': self.last_pred['predicted_path'],
                'confidence': self.last_pred['confidence'],
                'distance_to_center_m': round(self.last_pred['distance_to_center'], 2),
            },
            # Full tower snapshot — independent per user
            'towers': tower_snapshot,
            'network': self.last_net,
            'handover_log': self.handover_log[-20:],
        }


# ─── User registry ────────────────────────────────────────────────────────────
_multi_users: Dict[str, UserSession] = {}


# ─── Per-user helpers ─────────────────────────────────────────────────────────

def _init_walker(session: UserSession, start_seg: int = 0) -> None:
    """(Re)initialise the walker, predictor and controller for a user's current route."""
    idx = ROUTE_INDEX[session.route_name]
    wp = ROAD_ROUTES[idx]

    # Clamp start_seg to valid range
    start_seg = max(0, min(start_seg, len(wp) - 2))

    walker = WaypointWalker(wp, _SPEED_MPS)
    # Fast-forward walker to start_seg by copying index & position
    walker.seg_idx = start_seg
    walker.lat, walker.lon = wp[start_seg]
    if start_seg < len(wp) - 1:
        walker._heading = _bearing(*wp[start_seg], *wp[start_seg + 1])
    session.walker = walker
    session.lat, session.lon = wp[start_seg]
    session.heading = walker._heading

    session.predictor = TrajectoryPredictor()
    session.controller = TowerController()
    session._steer_offset = 0.0
    session._steer_ticks_left = 0


def _simulate_network(handover_triggered: bool, active_id: Optional[str]) -> dict:
    base = random.uniform(8, 18)
    ho_lat = random.uniform(18, 40) if handover_triggered else None
    if active_id:
        lat = round(base * 0.6 + random.uniform(0, 3), 2)
        tput = round(random.uniform(900, 1200), 1)
    else:
        lat = round(base + random.uniform(0, 5), 2)
        tput = round(random.uniform(400, 700), 1)
    return {
        'latency_ms': lat,
        'handover_latency_ms': round(ho_lat, 2) if ho_lat else None,
        'throughput_mbps': tput,
    }


def _append_log(session: UserSession, event: str,
                tower_id: Optional[str] = None, conf: float = 0.0) -> None:
    session.handover_log.append({
        'user_id': session.user_id,   # <── every log entry tagged with user_id
        'timestamp': datetime.datetime.utcnow().isoformat() + 'Z',
        'tick': session.tick,
        'event': event,
        'tower_id': tower_id,
        'confidence': conf,
        'lat': round(session.lat, 7),
        'lon': round(session.lon, 7),
        'heading': round(session.heading, 1),
        'speed_kmh': _VEHICLE_SPEED_KMH,
        'predicted_path': session.last_pred.get('predicted_path'),
        'distance_m': round(session.last_pred.get('distance_to_center', 0.0), 2),
        'latency_ms': session.last_net.get('latency_ms', 0.0),
        'throughput_mbps': session.last_net.get('throughput_mbps', 0.0),
    })
    if len(session.handover_log) > 100:
        session.handover_log = session.handover_log[-100:]


def _tick_user(session: UserSession) -> None:
    """Advance one user by one simulation tick."""
    if not session.running or session.walker is None:
        return

    session.tick += 1

    # ── Position update ──────────────────────────────────────────────────────
    lat, lon, hdg = session.walker.advance(_TICK_INTERVAL_S)

    # Apply steering offset if active (decays over time)
    if session._steer_ticks_left > 0:
        decay_factor = session._steer_ticks_left / _STEER_DECAY_TICKS
        effective_offset = session._steer_offset * decay_factor
        hdg = (hdg + effective_offset) % 360
        session._steer_ticks_left -= 1
        if session._steer_ticks_left == 0:
            session._steer_offset = 0.0

    session.lat, session.lon, session.heading = lat, lon, hdg

    # ── Prediction (independent per user) ───────────────────────────────────
    assert session.predictor is not None
    pred = session.predictor.predict_path(lat, lon, hdg, _VEHICLE_SPEED_KMH)
    session.last_pred = pred

    # ── Tower control (independent per user) ────────────────────────────────
    assert session.controller is not None
    changed = session.controller.apply_prediction(pred['predicted_path'], pred['confidence'])

    # ── Network (independent per user) ──────────────────────────────────────
    session.last_net = _simulate_network(changed, session.controller.active_tower_id)

    # ── Log handover events ──────────────────────────────────────────────────
    if changed:
        if session.controller.handover_active:
            _append_log(session, 'HANDOVER', session.controller.active_tower_id, pred['confidence'])
        else:
            _append_log(session, 'CLEAR')

    # ── Loop route when walker reaches the end ───────────────────────────────
    if session.walker.done:
        _init_walker(session)


def _normalize_uid(raw_id: str) -> str:
    cleaned = str(raw_id).strip().upper().replace('_', '-')
    if cleaned in ('USER-1', 'U-1', 'U1', '1'): return 'USER-01'
    if cleaned in ('USER-2', 'U-2', 'U2', '2'): return 'USER-02'
    if cleaned in ('USER-3', 'U-3', 'U3', '3'): return 'USER-03'
    if cleaned in ('USER-4', 'U-4', 'U4', '4'): return 'USER-04'
    if cleaned in ('USER-5', 'U-5', 'U5', '5'): return 'USER-05'
    return cleaned


def _apply_control(raw_user_id: str, action: str) -> None:
    """Apply a left or right steering command to a specific user."""
    norm_id = _normalize_uid(raw_user_id)
    session = _multi_users.get(norm_id) or _multi_users.get(raw_user_id)
    if not session:
        return
    if action == 'left':
        session._steer_offset = -_STEER_HEADING_OFFSET
    elif action == 'right':
        session._steer_offset = +_STEER_HEADING_OFFSET
    else:
        return
    session._steer_ticks_left = _STEER_DECAY_TICKS


def _build_payload() -> dict:
    """Build the full multi-user broadcast payload."""
    # Collect tower snapshot from first user (all share same tower locations)
    first = next(iter(_multi_users.values()), None)
    all_towers = {}
    if first and first.controller:
        all_towers = {tid: t.to_dict() for tid, t in first.controller.towers.items()}

    users_list = [s.to_dict() for s in _multi_users.values()]
    users_dict = {s.user_id: u for s, u in zip(_multi_users.values(), users_list)}

    return {
        'type': 'multi_update',
        'tick': max((s.tick for s in _multi_users.values()), default=0),
        'timestamp': datetime.datetime.utcnow().isoformat() + 'Z',
        'source': 'sim',
        'towers': {
            'all_towers': all_towers,
        },
        'users': users_list,
        'users_map': users_dict,
    }


# ─── Connection manager ───────────────────────────────────────────────────────

class MultiManager:
    def __init__(self):
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.active.discard(ws)

    async def broadcast(self, data: dict) -> None:
        dead: Set[WebSocket] = set()
        for ws in self.active:
            try:
                await ws.send_json(data)
            except Exception:
                dead.add(ws)
        self.active -= dead


_manager = MultiManager()

# ─── Broadcast loop ───────────────────────────────────────────────────────────

_loop_running = False
_loop_task: asyncio.Task | None = None


async def _run_loop() -> None:
    global _loop_running
    while _loop_running:
        for session in list(_multi_users.values()):
            _tick_user(session)
        payload = _build_payload()
        await _manager.broadcast(payload)
        await asyncio.sleep(_TICK_INTERVAL_S)


# ─── Seed five users at import time ──────────────────────────────────────────
# Exactly five active demo users: USER-01 to USER-05.
# Each user is distributed on a different route, starting at different coordinates,
# moving in different compass directions with independent predictors and controllers.

def _seed_users() -> None:
    configs = [
        ('USER-01', 'ROUTE_A',  0, '+1 (555) 010-0001'),  # West to East
        ('USER-02', 'ROUTE_B',  6, '+1 (555) 010-0002'),  # East to West
        ('USER-03', 'ROUTE_C', 14, '+1 (555) 010-0003'),  # North to South
        ('USER-04', 'ROUTE_D',  4, '+1 (555) 010-0004'),  # South to North
        ('USER-05', 'ROUTE_E',  2, '+1 (555) 010-0005'),  # South-West to North-East
    ]
    for uid, route, seg_offset, phone in configs:
        if uid not in _multi_users:
            session = UserSession(user_id=uid, route_name=route, phone_number=phone)
            _init_walker(session, start_seg=seg_offset)
            session.running = True
            _multi_users[uid] = session


_seed_users()


# ─── WebSocket endpoint ───────────────────────────────────────────────────────

@router.websocket('/ws/multi')
async def websocket_multi(websocket: WebSocket):
    global _loop_running, _loop_task
    await _manager.connect(websocket)

    # Send immediate state snapshot on connect so UI is not blank
    await websocket.send_json(_build_payload())

    if not _loop_running:
        _loop_running = True
        _loop_task = asyncio.create_task(_run_loop())

    try:
        while True:
            raw = await websocket.receive_text()

            # Parse incoming control messages
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue  # ignore heartbeats / non-JSON

            if not isinstance(msg, dict):
                continue

            msg_type = msg.get('type')

            if msg_type == 'control':
                user_id = msg.get('user_id', '')
                action  = msg.get('action', '')
                _apply_control(user_id, action)

    except WebSocketDisconnect:
        _manager.disconnect(websocket)
        if not _manager.active:
            _loop_running = False
            if _loop_task:
                _loop_task.cancel()
                _loop_task = None


# ─── REST API ─────────────────────────────────────────────────────────────────

@router.get('/api/multi/users')
def list_users():
    return [
        {
            'user_id': s.user_id,
            'route_name': s.route_name,
            'direction': ROUTE_DIRECTION.get(s.route_name, 'CUSTOM'),
            'running': s.running,
            'handover_count': s.controller.handover_count if s.controller else 0,
            'ping_pong_events': s.controller.ping_pong_events if s.controller else 0,
            'active_tower': s.controller.active_tower_id if s.controller else None,
            'handover_active': s.controller.handover_active if s.controller else False,
        }
        for s in _multi_users.values()
    ]


@router.get('/api/multi/stats')
def get_multi_stats():
    """Return overall aggregated statistics across all 5 demo users."""
    total_ho = sum(s.controller.handover_count if s.controller else 0 for s in _multi_users.values())
    total_pp = sum(s.controller.ping_pong_events if s.controller else 0 for s in _multi_users.values())
    naive_pp = max(total_ho * 0.35, 1) if total_ho > 0 else 0
    avoided = max(naive_pp - total_pp, 0)
    pct = round((avoided / naive_pp) * 100, 1) if naive_pp > 0 else 0.0

    return {
        'active_users': len(_multi_users),
        'total_handovers': total_ho,
        'ping_pong_events': total_pp,
        'ping_pong_reduction_pct': pct,
        'users': [
            {
                'user_id': s.user_id,
                'route': s.route_name,
                'direction': ROUTE_DIRECTION.get(s.route_name, 'CUSTOM'),
                'active_tower': s.controller.active_tower_id if s.controller else None,
                'handover_active': s.controller.handover_active if s.controller else False,
                'handover_count': s.controller.handover_count if s.controller else 0,
                'ping_pong_events': s.controller.ping_pong_events if s.controller else 0,
            }
            for s in _multi_users.values()
        ]
    }


@router.post('/api/multi/reset')
def reset_all():
    """Reset all five users to fresh state."""
    # Stop all users first
    for session in _multi_users.values():
        session.running = False
    # Clear and re-seed
    _multi_users.clear()
    _seed_users()
    return {'ok': True, 'users_reset': list(_multi_users.keys())}
