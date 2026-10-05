"""
routers/telemetry.py
--------------------
WebSocket endpoint at /ws/telemetry

Accepts incoming telemetry JSON from any sender (desktop sim or mobile GPS),
runs it through the prediction engine + tower controller, and broadcasts the
processed state to ALL connected clients on this endpoint.

This allows the dashboard to connect in "listen-only" mode and receive updates
driven by a real smartphone walking through an intersection.

Incoming message format:
  {"lat": float, "lon": float, "heading": float, "speed": float}

Special messages:
  "ping" — heartbeat from listener-only clients (dashboard in mobile mode)
  "reset" — resets predictor + controller state
"""

import asyncio
import datetime
import json
import random
from typing import Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.prediction_engine import TrajectoryPredictor
from app.services.tower_controller import TowerController

router = APIRouter()


# ── Connection manager (shared broadcast) ────────────────────────────────────

class TelemetryConnectionManager:
    def __init__(self):
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket):
        self.active.discard(ws)

    async def broadcast(self, data: dict):
        dead = set()
        for ws in self.active:
            try:
                await ws.send_json(data)
            except Exception:
                dead.add(ws)
        self.active -= dead


# ── Shared state (all telemetry clients share one prediction context) ────────

_manager = TelemetryConnectionManager()
_predictor = TrajectoryPredictor()
_controller = TowerController()
_tick = 0


def _reset_state():
    global _predictor, _controller, _tick
    _predictor = TrajectoryPredictor()
    _controller = TowerController()
    _tick = 0


def _simulate_network(handover_just_triggered: bool, active_tower_id: Optional[str]) -> dict:
    base_latency = random.uniform(8, 18)
    handover_lat = random.uniform(18, 40) if handover_just_triggered else None

    if active_tower_id is not None:
        latency = round(base_latency * 0.6 + random.uniform(0, 3), 2)
        throughput = round(random.uniform(900, 1200), 1)
    else:
        latency = round(base_latency + random.uniform(0, 5), 2)
        throughput = round(random.uniform(400, 700), 1)

    return {
        'latency_ms': latency,
        'handover_latency_ms': round(handover_lat, 2) if handover_lat else None,
        'throughput_mbps': throughput,
    }


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@router.websocket("/ws/telemetry")
async def websocket_telemetry(websocket: WebSocket):
    global _tick

    await _manager.connect(websocket)

    try:
        while True:
            raw = await websocket.receive_text()

            # Heartbeat from listener-only clients
            if raw.strip() in ('ping', 'pong', ''):
                continue

            # State reset request
            if raw.strip() == 'reset':
                _reset_state()
                await websocket.send_json({'type': 'reset_ack'})
                continue

            # Parse telemetry
            try:
                data = json.loads(raw)
                lat = float(data['lat'])
                lon = float(data['lon'])
                heading = float(data['heading'])
                speed = float(data['speed'])
                user_id = str(data.get('user_id', 'USER-01'))
            except (json.JSONDecodeError, KeyError, ValueError, TypeError):
                continue   # silently drop malformed frames

            _tick += 1

            pred = _predictor.predict_path(lat, lon, heading, speed)
            state_changed = _controller.apply_prediction(
                pred['predicted_path'], pred['confidence']
            )
            tower_snapshot = _controller.get_state_snapshot()
            net = _simulate_network(state_changed, _controller.active_tower_id)

            payload = {
                'tick': _tick,
                'timestamp': datetime.datetime.utcnow().isoformat() + 'Z',
                'source': data.get('source', 'unknown'),   # 'desktop' | 'mobile'
                'user_id': user_id,
                'vehicle': {
                    'lat': round(lat, 7),
                    'lon': round(lon, 7),
                    'heading': heading,
                    'speed_kmh': speed,
                },
                'prediction': {
                    'predicted_path': pred['predicted_path'],
                    'confidence': pred['confidence'],
                    'distance_to_center_m': pred['distance_to_center'],
                },
                'towers': tower_snapshot,
                'network': net,
            }

            await _manager.broadcast(payload)

    except WebSocketDisconnect:
        _manager.disconnect(websocket)
