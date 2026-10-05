"""
routers/simulation.py
---------------------
WebSocket endpoint at /ws/simulation

Streams a live simulation of a vehicle following real road waypoints
around the Nandanam / Anna Salai intersection (13.0827°N, 80.2707°E),
broadcasting combined state updates every 500 ms to all connected clients.

The vehicle follows pre-defined road paths (sequences of GPS waypoints
extracted from real street geometry), interpolating between each pair
to produce smooth, realistic sub-tick positions.

Payload schema (JSON per tick):
{
  "tick": int,
  "timestamp": str (ISO-8601),
  "source": "sim",
  "vehicle": {
    "lat": float, "lon": float,
    "heading": float,           # degrees, 0=N, 90=E, 180=S, 270=W
    "speed_kmh": float
  },
  "prediction": {
    "predicted_path": str | null,
    "confidence": float,
    "distance_to_center_m": float
  },
  "towers": { ... },            # TowerController.get_state_snapshot()
  "network": {
    "latency_ms": float,
    "handover_latency_ms": float | null,
    "throughput_mbps": float
  }
}
"""

import asyncio
import json
import math
import random
import datetime
from typing import Set, List, Tuple

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.prediction_engine import TrajectoryPredictor
from app.services.tower_controller import TowerController, CENTER_LAT, CENTER_LON

router = APIRouter()

# ─── Connection manager ──────────────────────────────────────────────────────

class ConnectionManager:
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


manager = ConnectionManager()

# ─── Simulation state ────────────────────────────────────────────────────────

_sim_running = False
_sim_task: asyncio.Task | None = None

_TICK_INTERVAL_S  = 0.5      # seconds between ticks
_VEHICLE_SPEED_KMH = 30.0    # ~8.33 m/s — city traffic speed
_SPEED_MPS         = _VEHICLE_SPEED_KMH / 3.6

# ─── Road waypoints ──────────────────────────────────────────────────────────
# Hand-crafted GPS waypoints traced along real streets around the
# Nandanam / Anna Salai / Dr Radhakrishnan Salai intersection, Chennai.
# Each route is a list of (lat, lon) tuples describing one coherent trip
# through the intersection area.  The simulation cycles through all routes.
#
# Coordinate reference:
#   Center intersection ≈ 13.0827 N, 80.2707 E
#
# Routes:
#   ROUTE_NS  — approaches from north on Anna Salai, passes intersection,
#               turns right (west) on Spur Tank Rd, then loops back.
#   ROUTE_EW  — approaches from east on Dr Radhakrishnan Salai,
#               passes intersection, turns left (south) and loops.
#   ROUTE_SN  — approaches from south-west, turns at intersection, exits NE.
#
# Each waypoint is a real-world coordinate; the sim interpolates between
# them at the configured speed, recomputing heading at every step.

Waypoint = Tuple[float, float]   # (lat, lon)

ROAD_ROUTES: List[List[Waypoint]] = [
    # ROUTE_A
    [
        (13.080141, 80.259616),
        (13.079534, 80.259379),
        (13.079587, 80.260108),
        (13.079714, 80.260756),
        (13.079756, 80.260927),
        (13.079974, 80.261502),
        (13.080061, 80.261722),
        (13.080113, 80.261887),
        (13.080295, 80.262785),
        (13.080557, 80.263972),
        (13.080784, 80.265167),
        (13.080804, 80.265395),
        (13.080779, 80.266937),
        (13.080766, 80.267477),
        (13.080770, 80.268009),
        (13.080785, 80.268574),
        (13.080790, 80.268893),
        (13.080802, 80.269406),
        (13.080827, 80.270171),
        (13.080841, 80.270475),
        (13.080862, 80.270672),
        (13.080927, 80.270857),
        (13.081172, 80.270882),
        (13.081441, 80.270848),
        (13.081803, 80.270794),
        (13.082533, 80.270699),
        (13.082697, 80.270678),
        (13.083069, 80.270630),
        (13.083315, 80.270592),
        (13.081745, 80.270875),
        (13.081473, 80.270911),
        (13.081272, 80.270948),
        (13.081145, 80.271072),
        (13.081102, 80.271268),
        (13.081135, 80.271450),
        (13.081177, 80.271623),
        (13.081237, 80.271916),
        (13.081276, 80.272100),
        (13.081303, 80.272293),
        (13.081332, 80.272491),
        (13.081395, 80.272802),
        (13.081441, 80.272994),
        (13.081495, 80.273280),
        (13.081557, 80.273591),
        (13.081631, 80.273956),
        (13.081676, 80.274535),
        (13.081694, 80.274741),
        (13.081708, 80.275054),
        (13.081732, 80.275277),
        (13.081723, 80.275458),
        (13.081750, 80.275782),
        (13.081814, 80.276053),
        (13.081898, 80.276318),
        (13.081921, 80.276499),
        (13.082092, 80.277850),
        (13.082261, 80.278016),
        (13.083026, 80.278091),
        (13.083387, 80.278119),
        (13.083581, 80.278094),
        (13.084061, 80.278130)
    ],
    # ROUTE_B
    [
        (13.084071, 80.278006),
        (13.085358, 80.278308),
        (13.085280, 80.278642),
        (13.085171, 80.279108),
        (13.084709, 80.279053),
        (13.084035, 80.279003),
        (13.083655, 80.278957),
        (13.083468, 80.278980),
        (13.083249, 80.278957),
        (13.082945, 80.278820),
        (13.082767, 80.278739),
        (13.082166, 80.278467),
        (13.082020, 80.278227),
        (13.081996, 80.278006),
        (13.081935, 80.277489),
        (13.081782, 80.276353),
        (13.081710, 80.276052),
        (13.081647, 80.275669),
        (13.081632, 80.275494),
        (13.081621, 80.275157),
        (13.081595, 80.274799),
        (13.081529, 80.274008),
        (13.081404, 80.273391),
        (13.081254, 80.272628),
        (13.081142, 80.271934),
        (13.081052, 80.271539),
        (13.080987, 80.271285),
        (13.080936, 80.271092),
        (13.080963, 80.270919),
        (13.081172, 80.270882),
        (13.081441, 80.270848),
        (13.081803, 80.270794),
        (13.082533, 80.270699),
        (13.082697, 80.270678),
        (13.083069, 80.270630),
        (13.083315, 80.270592),
        (13.081745, 80.270875),
        (13.081473, 80.270911),
        (13.081272, 80.270948),
        (13.081145, 80.271072),
        (13.081102, 80.271268),
        (13.081135, 80.271450),
        (13.081177, 80.271623),
        (13.081237, 80.271916),
        (13.081276, 80.272100),
        (13.081303, 80.272293),
        (13.081332, 80.272491),
        (13.081395, 80.272802),
        (13.081441, 80.272994),
        (13.081495, 80.273280),
        (13.081557, 80.273591),
        (13.081631, 80.273956),
        (13.081404, 80.273391),
        (13.081254, 80.272628),
        (13.081142, 80.271934),
        (13.081052, 80.271539),
        (13.080987, 80.271285),
        (13.080936, 80.271092),
        (13.080838, 80.270877),
        (13.080783, 80.270640),
        (13.080772, 80.270454),
        (13.080764, 80.270198),
        (13.080672, 80.268022),
        (13.080680, 80.266998),
        (13.080711, 80.265407),
        (13.080692, 80.265233),
        (13.080611, 80.264789),
        (13.080451, 80.264025),
        (13.080256, 80.263126),
        (13.080190, 80.262826),
        (13.080146, 80.262595),
        (13.080023, 80.261960),
        (13.079827, 80.261432),
        (13.079695, 80.261110),
        (13.079633, 80.260945),
        (13.079506, 80.260326),
        (13.079412, 80.259556),
        (13.079319, 80.258789),
        (13.079500, 80.259366),
        (13.080141, 80.259616)
    ],
    # ROUTE_C
    [
        (13.088001, 80.265016),
        (13.087762, 80.265118),
        (13.087695, 80.265719),
        (13.087600, 80.265922),
        (13.087400, 80.265920),
        (13.086771, 80.265878),
        (13.085440, 80.265701),
        (13.085371, 80.266155),
        (13.085304, 80.266605),
        (13.085277, 80.266776),
        (13.084252, 80.266787),
        (13.084047, 80.266767),
        (13.083757, 80.266778),
        (13.083502, 80.266787),
        (13.083292, 80.266807),
        (13.083101, 80.266831),
        (13.082907, 80.266856),
        (13.082636, 80.266873),
        (13.082296, 80.266875),
        (13.081116, 80.266924),
        (13.080779, 80.266937),
        (13.080766, 80.267477),
        (13.080770, 80.268009),
        (13.080785, 80.268574),
        (13.080790, 80.268893),
        (13.080802, 80.269406),
        (13.080827, 80.270171),
        (13.080841, 80.270475),
        (13.080862, 80.270672),
        (13.080927, 80.270857),
        (13.081172, 80.270882),
        (13.081441, 80.270848),
        (13.081803, 80.270794),
        (13.082533, 80.270699),
        (13.082697, 80.270678),
        (13.083069, 80.270630),
        (13.083315, 80.270592),
        (13.081745, 80.270875),
        (13.081473, 80.270911),
        (13.081272, 80.270948),
        (13.081145, 80.271072),
        (13.081102, 80.271268),
        (13.081135, 80.271450),
        (13.081177, 80.271623),
        (13.081237, 80.271916),
        (13.081276, 80.272100),
        (13.081303, 80.272293),
        (13.081332, 80.272491),
        (13.081395, 80.272802),
        (13.081441, 80.272994),
        (13.081495, 80.273280),
        (13.081557, 80.273591),
        (13.081631, 80.273956),
        (13.081676, 80.274535),
        (13.081694, 80.274741),
        (13.081708, 80.275054),
        (13.081732, 80.275277),
        (13.081723, 80.275458),
        (13.081750, 80.275782),
        (13.081814, 80.276053),
        (13.081898, 80.276318),
        (13.081921, 80.276499),
        (13.082092, 80.277850),
        (13.082166, 80.278467),
        (13.082020, 80.278227),
        (13.081996, 80.278006),
        (13.081935, 80.277489),
        (13.081782, 80.276353),
        (13.081710, 80.276052),
        (13.081647, 80.275669),
        (13.081632, 80.275494),
        (13.081531, 80.275310),
        (13.080844, 80.275272),
        (13.080229, 80.275339),
        (13.080057, 80.275359),
        (13.079867, 80.275373),
        (13.079665, 80.275362),
        (13.079484, 80.275334),
        (13.079284, 80.275291),
        (13.078977, 80.275216),
        (13.078786, 80.275202),
        (13.078576, 80.275278),
        (13.078449, 80.275397),
        (13.078348, 80.275602),
        (13.078261, 80.275881),
        (13.078198, 80.276057),
        (13.078013, 80.276212),
        (13.077754, 80.276235),
        (13.077212, 80.276259),
        (13.077597, 80.276115),
        (13.077868, 80.276093),
        (13.078032, 80.276009),
        (13.078207, 80.275496),
        (13.078303, 80.275262),
        (13.078435, 80.275136),
        (13.078381, 80.274946)
    ],
    # ROUTE_D
    [
        (13.078374, 80.274914),
        (13.078435, 80.275136),
        (13.078303, 80.275262),
        (13.078207, 80.275496),
        (13.078079, 80.275939),
        (13.077965, 80.276064),
        (13.077657, 80.276112),
        (13.077160, 80.276134),
        (13.077834, 80.276150),
        (13.078001, 80.276117),
        (13.078133, 80.275988),
        (13.078214, 80.275726),
        (13.078274, 80.275557),
        (13.078352, 80.275389),
        (13.078479, 80.275245),
        (13.078659, 80.275146),
        (13.078844, 80.275121),
        (13.079084, 80.275157),
        (13.079509, 80.275253),
        (13.079723, 80.275289),
        (13.079931, 80.275292),
        (13.080138, 80.275273),
        (13.081429, 80.275141),
        (13.081621, 80.275157),
        (13.081595, 80.274799),
        (13.081529, 80.274008),
        (13.081404, 80.273391),
        (13.081254, 80.272628),
        (13.081142, 80.271934),
        (13.081052, 80.271539),
        (13.080987, 80.271285),
        (13.080936, 80.271092),
        (13.080963, 80.270919),
        (13.081172, 80.270882),
        (13.081441, 80.270848),
        (13.081803, 80.270794),
        (13.082533, 80.270699),
        (13.082697, 80.270678),
        (13.083069, 80.270630),
        (13.083315, 80.270592),
        (13.083963, 80.270496),
        (13.084182, 80.270465),
        (13.084343, 80.270321),
        (13.084553, 80.269813),
        (13.084703, 80.269481),
        (13.084786, 80.269174),
        (13.084890, 80.268682),
        (13.084911, 80.268501),
        (13.084918, 80.268223),
        (13.084924, 80.267914),
        (13.084963, 80.267715),
        (13.085216, 80.266779),
        (13.085244, 80.266594),
        (13.085285, 80.266299),
        (13.085367, 80.265691),
        (13.086634, 80.265868),
        (13.087400, 80.265920),
        (13.087600, 80.265922),
        (13.087695, 80.265719),
        (13.087762, 80.265118),
        (13.088001, 80.265016)
    ],
    # ROUTE_E
    [
        (13.075897, 80.264127),
        (13.076097, 80.264202),
        (13.076370, 80.264169),
        (13.076597, 80.264150),
        (13.076597, 80.264669),
        (13.076472, 80.265265),
        (13.076626, 80.265365),
        (13.076840, 80.265426),
        (13.077146, 80.265496),
        (13.077340, 80.265510),
        (13.077595, 80.265491),
        (13.077996, 80.265441),
        (13.078501, 80.265384),
        (13.078843, 80.265338),
        (13.079109, 80.265293),
        (13.080374, 80.265148),
        (13.080679, 80.265132),
        (13.080804, 80.265395),
        (13.080779, 80.266937),
        (13.080766, 80.267477),
        (13.080770, 80.268009),
        (13.080785, 80.268574),
        (13.080790, 80.268893),
        (13.080802, 80.269406),
        (13.080827, 80.270171),
        (13.080841, 80.270475),
        (13.080862, 80.270672),
        (13.080927, 80.270857),
        (13.081172, 80.270882),
        (13.081441, 80.270848),
        (13.081803, 80.270794),
        (13.082533, 80.270699),
        (13.082697, 80.270678),
        (13.083069, 80.270630),
        (13.083315, 80.270592),
        (13.081745, 80.270875),
        (13.081473, 80.270911),
        (13.081272, 80.270948),
        (13.081145, 80.271072),
        (13.081102, 80.271268),
        (13.081135, 80.271450),
        (13.081177, 80.271623),
        (13.081237, 80.271916),
        (13.081276, 80.272100),
        (13.081303, 80.272293),
        (13.081332, 80.272491),
        (13.081395, 80.272802),
        (13.081441, 80.272994),
        (13.081495, 80.273280),
        (13.081557, 80.273591),
        (13.081631, 80.273956),
        (13.081676, 80.274535),
        (13.081694, 80.274741),
        (13.081708, 80.275054),
        (13.081732, 80.275277),
        (13.081723, 80.275458),
        (13.081750, 80.275782),
        (13.081814, 80.276053),
        (13.081956, 80.276240),
        (13.082306, 80.276240),
        (13.082571, 80.276207),
        (13.082862, 80.276169),
        (13.085088, 80.275872),
        (13.086639, 80.275675),
        (13.087058, 80.275654),
        (13.088040, 80.275540),
        (13.088307, 80.275509),
        (13.089201, 80.275391),
        (13.089942, 80.275293),
        (13.090659, 80.275218),
        (13.091420, 80.275204),
        (13.090376, 80.275339),
        (13.089929, 80.275395),
        (13.089477, 80.275437),
        (13.089254, 80.275461),
        (13.089032, 80.275484),
        (13.088508, 80.275549),
        (13.088664, 80.276612),
        (13.088777, 80.276736),
        (13.088940, 80.276960),
        (13.089069, 80.277234),
        (13.089162, 80.277407),
        (13.089386, 80.277662)
    ],
]


# ─── Waypoint walker ─────────────────────────────────────────────────────────

def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compass bearing in degrees [0, 360) from point 1 to point 2."""
    dlat = lat2 - lat1
    dlon = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    angle = math.degrees(math.atan2(dlon, dlat))
    return angle % 360


def _dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Approximate Euclidean distance in metres between two close points."""
    dlat = (lat2 - lat1) * 111_000
    dlon = (lon2 - lon1) * 108_100 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.sqrt(dlat ** 2 + dlon ** 2)


class WaypointWalker:
    """
    Walks through a sequence of waypoints at a fixed speed, yielding
    (lat, lon, heading) on every advance() call.

    Heading is smoothed with a low-pass filter to avoid abrupt jumps
    at waypoint boundaries — this mimics the inertia of a real vehicle.
    """
    HEADING_SMOOTHING = 0.25   # 0 = instant snap, 1 = never changes

    def __init__(self, waypoints: List[Waypoint], speed_mps: float):
        self.waypoints   = waypoints
        self.speed_mps   = speed_mps
        self.seg_idx     = 0
        self.lat, self.lon = waypoints[0]
        self._heading    = _bearing(*waypoints[0], *waypoints[1]) if len(waypoints) > 1 else 0.0
        self.done        = False

    def advance(self, dt: float) -> Tuple[float, float, float]:
        """Move forward dt seconds.  Returns (lat, lon, heading)."""
        if self.done:
            return self.lat, self.lon, self._heading

        remaining = self.speed_mps * dt   # metres left this tick

        while remaining > 0 and self.seg_idx < len(self.waypoints) - 1:
            nx_lat, nx_lon = self.waypoints[self.seg_idx + 1]
            seg_bearing    = _bearing(self.lat, self.lon, nx_lat, nx_lon)
            seg_dist       = _dist_m(self.lat, self.lon, nx_lat, nx_lon)

            if remaining >= seg_dist:
                # Move to next waypoint and continue
                remaining -= seg_dist
                self.lat, self.lon = nx_lat, nx_lon
                self.seg_idx += 1
                # Smooth heading toward new segment bearing
                self._heading = _smooth_heading(self._heading, seg_bearing,
                                                self.HEADING_SMOOTHING)
            else:
                # Move partial distance along current segment
                frac = remaining / seg_dist if seg_dist > 0 else 0
                self.lat  += frac * (nx_lat - self.lat)
                self.lon  += frac * (nx_lon - self.lon)
                self._heading = _smooth_heading(self._heading, seg_bearing,
                                                self.HEADING_SMOOTHING)
                remaining = 0

        if self.seg_idx >= len(self.waypoints) - 1:
            self.done = True

        return self.lat, self.lon, self._heading


def _smooth_heading(current: float, target: float, alpha: float) -> float:
    """Exponential moving average on heading, handling 360→0 wrap."""
    diff = ((target - current + 180) % 360) - 180
    return (current + (1 - alpha) * diff) % 360


# ─── Network simulation ──────────────────────────────────────────────────────

def _simulate_network(handover_just_triggered: bool, active_tower_id: str | None) -> dict:
    base_latency = random.uniform(8, 18)
    handover_lat = random.uniform(18, 40) if handover_just_triggered else None

    if active_tower_id is not None:
        latency    = round(base_latency * 0.6 + random.uniform(0, 3), 2)
        throughput = round(random.uniform(900, 1200), 1)
    else:
        latency    = round(base_latency + random.uniform(0, 5), 2)
        throughput = round(random.uniform(400, 700), 1)

    return {
        'latency_ms':         latency,
        'handover_latency_ms': round(handover_lat, 2) if handover_lat else None,
        'throughput_mbps':     throughput,
    }


# ─── Simulation loop ─────────────────────────────────────────────────────────

async def _run_simulation():
    """
    Coroutine that cycles through ROAD_ROUTES indefinitely.
    For each route a WaypointWalker advances the vehicle smoothly,
    then the predictor and tower controller evaluate the new position.
    """
    predictor  = TrajectoryPredictor()
    controller = TowerController()
    tick       = 0
    route_idx  = 0

    walker = WaypointWalker(ROAD_ROUTES[route_idx], _SPEED_MPS)

    while _sim_running:
        tick += 1

        # Advance vehicle position
        lat, lon, heading = walker.advance(_TICK_INTERVAL_S)

        # Prediction
        pred = predictor.predict_path(lat, lon, heading, _VEHICLE_SPEED_KMH)

        # Tower state
        state_changed  = controller.apply_prediction(pred['predicted_path'], pred['confidence'])
        tower_snapshot = controller.get_state_snapshot()

        # Network metrics
        net = _simulate_network(state_changed, controller.active_tower_id)

        payload = {
            'tick':      tick,
            'timestamp': datetime.datetime.utcnow().isoformat() + 'Z',
            'source':    'sim',
            'vehicle': {
                'lat':       round(lat, 7),
                'lon':       round(lon, 7),
                'heading':   round(heading, 1),
                'speed_kmh': _VEHICLE_SPEED_KMH,
            },
            'prediction': {
                'predicted_path':     pred['predicted_path'],
                'confidence':         pred['confidence'],
                'distance_to_center_m': pred['distance_to_center'],
            },
            'towers':  tower_snapshot,
            'network': net,
        }

        # Multi-user data enrichment for dual-endpoint compatibility
        try:
            from app.routers.multi_user import _multi_users, _manager as multi_mgr, _tick_user
            if not multi_mgr.active:
                for u_sess in list(_multi_users.values()):
                    _tick_user(u_sess)
            u_list = [s.to_dict() for s in _multi_users.values()]
            payload['users'] = u_list
            payload['users_map'] = {s.user_id: u for s, u in zip(_multi_users.values(), u_list)}
        except Exception:
            pass

        await manager.broadcast(payload)

        # Advance to next route when walker is done
        if walker.done:
            route_idx = (route_idx + 1) % len(ROAD_ROUTES)
            walker    = WaypointWalker(ROAD_ROUTES[route_idx], _SPEED_MPS)
            predictor = TrajectoryPredictor()   # fresh consecutive state
            controller.reset_to_default()

        await asyncio.sleep(_TICK_INTERVAL_S)


# ─── WebSocket endpoint ───────────────────────────────────────────────────────

@router.websocket("/ws/simulation")
async def websocket_simulation(websocket: WebSocket):
    global _sim_running, _sim_task

    await manager.connect(websocket)

    if not _sim_running:
        _sim_running = True
        _sim_task = asyncio.create_task(_run_simulation())

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        if not manager.active:
            _sim_running = False
            if _sim_task:
                _sim_task.cancel()
                _sim_task = None
