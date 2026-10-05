"""
tower_controller.py
-------------------
Virtual 5G cellular base station state manager.

Intersection center: Lat 13.0827, Lon 80.2707
Towers are positioned ~150m along each of the 8 exit paths.
"""

import os
from dataclasses import dataclass, field, asdict
from typing import Literal, Dict, Optional

# ─── Types ───────────────────────────────────────────────────────────────────

TowerStatus = Literal['CONNECTED', 'IDLE', 'SUPPRESSED', 'BEAMFORMED_ACTIVE']

# ─── Data model ──────────────────────────────────────────────────────────────

@dataclass
class Tower:
    id: str
    name: str
    path: str                          # PATH_A / PATH_B / PATH_C / PATH_D
    coordinates: Dict[str, float]      # {"lat": ..., "lon": ...}
    frequency_band: str                # e.g. "n78" (3.5 GHz Sub-6)
    status: TowerStatus
    allocated_power_dbm: float

    def to_dict(self) -> dict:
        return asdict(self)


# ─── Controller ──────────────────────────────────────────────────────────────

# ~150 m offset in degrees (1° lat ≈ 111,000 m; 1° lon at 13°N ≈ 108,100 m)
_LAT_OFFSET = 150 / 111_000   # ≈ 0.001351°
_LON_OFFSET = 150 / 108_100   # ≈ 0.001388°
_DIAG_LAT_OFFSET = _LAT_OFFSET * 0.7071
_DIAG_LON_OFFSET = _LON_OFFSET * 0.7071

CENTER_LAT = 13.0827
CENTER_LON = 80.2707

_DEFAULT_POWER_DBM = 20.0
_BEAMFORMED_POWER_DBM = 30.0
_SUPPRESSED_POWER_DBM = 0.0


class TowerController:
    """
    Manages the virtual state of 4 5G NR base stations arranged around
    a single intersection.  State transitions are driven by handover
    predictions produced by TrajectoryPredictor.
    """

    def __init__(self):
        # ── Asymmetric, real-world-style tower coordinates ────────────────────
        # Center: 13.0827°N, 80.2707°E  (Anna Salai / Nandanam, Chennai)
        # Each tower is placed at a realistic, non-uniform distance & bearing,
        # mimicking deployment on available rooftops / structures.
        #
        #   1° lat  ≈ 111,000 m  →  1 m ≈ 9.009e-6°
        #   1° lon  ≈ 108,100 m  →  1 m ≈ 9.251e-6°  (at ~13°N)
        #
        # (bearing from center, horiz distance)
        #   A: ~355° (just west of N), 165 m  → rooftop on northern block
        #   B:  ~52° (NE),            210 m  → comm tower on NE corner block
        #   C:  ~88° (E, almost),     130 m  → building east side, close
        #   D: ~142° (SE),            190 m  → apartment block SE
        #   E: ~175° (SSouth),        220 m  → tall structure south
        #   F: ~238° (SW),            145 m  → small mast SW cluster
        #   G: ~274° (W),             180 m  → water-tower rooftop W
        #   H: ~318° (NW),             95 m  → short mast NW, close

        _m = 1e-6  # micro-degree shorthand

        self.towers: Dict[str, Tower] = {
            # ── A  (PATH_A ≈ North) ──────────────────────────────────────────
            # bearing ~355°, distance 165 m → almost north, slightly west
            'TOWER_A': Tower(
                id='TOWER_A',
                name='Alpha-Node NR/5G (N)',
                path='PATH_A',
                coordinates={
                    'lat': 13.0827 + 165 * 9.009e-6 * 0.9962,   # cos(5°)
                    'lon': 80.2707 + 165 * 9.251e-6 * (-0.0872), # -sin(5°)
                },
                frequency_band='n78',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
            # ── B  (PATH_B ≈ NE) ─────────────────────────────────────────────
            # bearing ~52°, distance 210 m
            'TOWER_B': Tower(
                id='TOWER_B',
                name='Beta-Node NR/5G (NE)',
                path='PATH_B',
                coordinates={
                    'lat': 13.0827 + 210 * 9.009e-6 * 0.6157,   # cos(52°)
                    'lon': 80.2707 + 210 * 9.251e-6 * 0.7880,   # sin(52°)
                },
                frequency_band='n258',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
            # ── C  (PATH_C ≈ East) ───────────────────────────────────────────
            # bearing ~88°, distance 130 m — close building to the east
            'TOWER_C': Tower(
                id='TOWER_C',
                name='Gamma-Node NR/5G (E)',
                path='PATH_C',
                coordinates={
                    'lat': 13.0827 + 130 * 9.009e-6 * 0.0349,   # cos(88°)
                    'lon': 80.2707 + 130 * 9.251e-6 * 0.9994,   # sin(88°)
                },
                frequency_band='n77',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
            # ── D  (PATH_D ≈ SE) ─────────────────────────────────────────────
            # bearing ~142°, distance 190 m
            'TOWER_D': Tower(
                id='TOWER_D',
                name='Delta-Node NR/5G (SE)',
                path='PATH_D',
                coordinates={
                    'lat': 13.0827 + 190 * 9.009e-6 * (-0.7880), # cos(142°) = -cos(38°)
                    'lon': 80.2707 + 190 * 9.251e-6 * 0.6157,    # sin(142°) =  sin(38°)
                },
                frequency_band='n78',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
            # ── E  (PATH_E ≈ South) ──────────────────────────────────────────
            # bearing ~175°, distance 220 m — tall south structure
            'TOWER_E': Tower(
                id='TOWER_E',
                name='Epsilon-Node NR/5G (S)',
                path='PATH_E',
                coordinates={
                    'lat': 13.0827 + 220 * 9.009e-6 * (-0.9962), # cos(175°)
                    'lon': 80.2707 + 220 * 9.251e-6 * 0.0872,    # sin(175°)
                },
                frequency_band='n78',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
            # ── F  (PATH_F ≈ SW) ─────────────────────────────────────────────
            # bearing ~238°, distance 145 m — compact SW mast
            'TOWER_F': Tower(
                id='TOWER_F',
                name='Zeta-Node NR/5G (SW)',
                path='PATH_F',
                coordinates={
                    'lat': 13.0827 + 145 * 9.009e-6 * (-0.5299), # cos(238°)
                    'lon': 80.2707 + 145 * 9.251e-6 * (-0.8480), # sin(238°)
                },
                frequency_band='n258',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
            # ── G  (PATH_G ≈ West) ───────────────────────────────────────────
            # bearing ~274°, distance 180 m — water tower W
            'TOWER_G': Tower(
                id='TOWER_G',
                name='Eta-Node NR/5G (W)',
                path='PATH_G',
                coordinates={
                    'lat': 13.0827 + 180 * 9.009e-6 * (-0.0698), # cos(274°)
                    'lon': 80.2707 + 180 * 9.251e-6 * (-0.9976), # sin(274°)
                },
                frequency_band='n77',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
            # ── H  (PATH_H ≈ NW) ─────────────────────────────────────────────
            # bearing ~318°, distance 95 m — short close mast NW
            'TOWER_H': Tower(
                id='TOWER_H',
                name='Theta-Node NR/5G (NW)',
                path='PATH_H',
                coordinates={
                    'lat': 13.0827 + 95 * 9.009e-6 * 0.7431,    # cos(318°) = cos(-42°)
                    'lon': 80.2707 + 95 * 9.251e-6 * (-0.6691), # sin(318°) = -sin(42°)
                },
                frequency_band='n78',
                status='CONNECTED',
                allocated_power_dbm=_DEFAULT_POWER_DBM,
            ),
        }

        # Ping-pong handover tracking
        self.handover_count: int = 0
        self.ping_pong_events: int = 0
        self._last_active_tower: Optional[str] = None
        self._previous_active_tower: Optional[str] = None

        # Current handover state
        self.handover_active: bool = False
        self.active_tower_id: Optional[str] = None
        
        self.locked_tower = os.environ.get("SELECTED_TOWER", "AUTO")
        if self.locked_tower != "AUTO" and self.locked_tower in self.towers:
            self._trigger_handover_override(self.locked_tower)

    def _trigger_handover_override(self, target_tower_id: str):
        for tid, tower in self.towers.items():
            if tid == target_tower_id:
                tower.status = 'BEAMFORMED_ACTIVE'
                tower.allocated_power_dbm = _BEAMFORMED_POWER_DBM
            else:
                tower.status = 'SUPPRESSED'
                tower.allocated_power_dbm = _SUPPRESSED_POWER_DBM
        self.handover_active = True
        self.active_tower_id = target_tower_id
        self._last_active_tower = target_tower_id

    # ── State transitions ────────────────────────────────────────────────────

    def reset_to_default(self) -> None:
        """Return all towers to their default CONNECTED / 20 dBm state."""
        for tower in self.towers.values():
            tower.status = 'CONNECTED'
            tower.allocated_power_dbm = _DEFAULT_POWER_DBM
        self.handover_active = False
        self.active_tower_id = None

    def trigger_handover(self, target_path: str, confidence: float) -> bool:
        """
        Trigger a beamformed handover to the tower serving `target_path`.

        Returns True if a NEW handover was triggered (state actually changed).
        """
        # Find the tower serving the predicted path
        target_tower_id = next(
            (tid for tid, t in self.towers.items() if t.path == target_path),
            None
        )
        if target_tower_id is None:
            return False

        # Avoid redundant re-triggers for the same tower
        if self.handover_active and self.active_tower_id == target_tower_id:
            return False

        # Track ping-pong: A→B→A within consecutive handovers counts as ping-pong
        if (self._last_active_tower is not None and
                self._last_active_tower != target_tower_id and
                self._previous_active_tower == target_tower_id):
            self.ping_pong_events += 1

        self._previous_active_tower = self._last_active_tower
        self._last_active_tower = target_tower_id
        self.handover_count += 1

        # Apply state
        for tid, tower in self.towers.items():
            if tid == target_tower_id:
                tower.status = 'BEAMFORMED_ACTIVE'
                tower.allocated_power_dbm = _BEAMFORMED_POWER_DBM
            else:
                tower.status = 'SUPPRESSED'
                tower.allocated_power_dbm = _SUPPRESSED_POWER_DBM

        self.handover_active = True
        self.active_tower_id = target_tower_id
        return True

    # ── Convenience ─────────────────────────────────────────────────────────

    def apply_prediction(self, predicted_path: Optional[str], confidence: float) -> bool:
        """
        Main entry point called each simulation tick.
        Triggers handover when confidence > 0.8, otherwise resets to default.
        Returns True if state changed.
        """
        if getattr(self, 'locked_tower', 'AUTO') != 'AUTO':
            return False

        if predicted_path is not None and confidence > 0.8:
            return self.trigger_handover(predicted_path, confidence)
        elif self.handover_active:
            self.reset_to_default()
            return True
        return False

    def get_state_snapshot(self) -> dict:
        """Return a serialisable snapshot of the full tower state."""
        active = self.towers.get(self.active_tower_id) if self.active_tower_id else None
        suppressed = [
            t.to_dict()
            for tid, t in self.towers.items()
            if t.status == 'SUPPRESSED'
        ]
        return {
            'handover_active': self.handover_active,
            'active_tower': active.to_dict() if active else None,
            'suppressed_towers': suppressed,
            'all_towers': {tid: t.to_dict() for tid, t in self.towers.items()},
            'stats': {
                'total_handovers': self.handover_count,
                'ping_pong_events': self.ping_pong_events,
                'ping_pong_reduction_pct': self._ping_pong_reduction_pct(),
            }
        }

    def _ping_pong_reduction_pct(self) -> float:
        """
        Estimate ping-pong reduction vs a naïve RSSI-only scheme.
        Naïve rate assumed at 35 % of total handovers for reference baseline.
        """
        if self.handover_count == 0:
            return 0.0
        naive_pp = max(self.handover_count * 0.35, 1)
        avoided = max(naive_pp - self.ping_pong_events, 0)
        return round((avoided / naive_pp) * 100, 1)
