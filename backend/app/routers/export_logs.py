"""
routers/export_logs.py
-----------------------
REST endpoint at GET /api/export-logs

Returns a server-side summary of current simulation and telemetry state,
including tower states and handover statistics. This complements the
client-side JSON/CSV export that captures the full timestamped log stream.

Endpoint supports both JSON (default) and CSV output via ?format=csv.
"""

import csv
import io
import datetime
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, StreamingResponse

# Import shared state from sibling routers
from app.routers.simulation import manager as sim_manager, _sim_running
from app.routers.telemetry import (
    _manager as tel_manager,
    _controller as tel_controller,
    _predictor as tel_predictor,
    _tick as tel_tick,
)

router = APIRouter()


def _build_export_payload() -> dict:
    """Build a structured export payload from current runtime state."""
    # Simulation state
    sim_active_clients = len(sim_manager.active)
    sim_running = _sim_running

    # Telemetry state
    tel_active_clients = len(tel_manager.active)
    tel_snapshot = tel_controller.get_state_snapshot()

    # Tower states as flat list (for CSV)
    tower_rows = []
    for tid, tower in tel_snapshot['all_towers'].items():
        tower_rows.append({
            'tower_id': tid,
            'name': tower['name'],
            'path': tower['path'],
            'status': tower['status'],
            'frequency_band': tower['frequency_band'],
            'allocated_power_dbm': tower['allocated_power_dbm'],
            'lat': tower['coordinates']['lat'],
            'lon': tower['coordinates']['lon'],
        })

    return {
        'exported_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'server': {
            'simulation_running': sim_running,
            'simulation_clients': sim_active_clients,
            'telemetry_clients': tel_active_clients,
        },
        'telemetry': {
            'total_ticks': tel_tick,
            'handover_active': tel_snapshot['handover_active'],
            'active_tower': tel_snapshot['active_tower'],
            'stats': tel_snapshot['stats'],
        },
        'tower_states': tower_rows,
        'multi_users': [
            {
                'user_id': s.user_id,
                'route': s.route_name,
                'tick': s.tick,
                'lat': round(s.lat, 7),
                'lon': round(s.lon, 7),
                'heading': round(s.heading, 1),
                'active_tower': s.controller.active_tower_id if s.controller else None,
                'handover_count': s.controller.handover_count if s.controller else 0,
                'ping_pong_events': s.controller.ping_pong_events if s.controller else 0,
            }
            for s in __import__('app.routers.multi_user', fromlist=['_multi_users'])._multi_users.values()
        ] if hasattr(__import__('app.routers.multi_user', fromlist=['_multi_users']), '_multi_users') else [],
    }


@router.get("/api/export-logs")
def export_logs(format: str = Query(default="json", pattern="^(json|csv)$")):
    """
    Export current server-side handover log snapshot.

    Query params:
      ?format=json  (default) — returns pretty-printed JSON
      ?format=csv   — returns CSV with tower state rows
    """
    payload = _build_export_payload()

    if format == "csv":
        output = io.StringIO()
        # Write metadata header
        output.write(f"# Predictive 5G Handover — Server Export\n")
        output.write(f"# exported_at,{payload['exported_at']}\n")
        output.write(f"# simulation_running,{payload['server']['simulation_running']}\n")
        output.write(f"# total_ticks,{payload['telemetry']['total_ticks']}\n")
        output.write(f"# total_handovers,{payload['telemetry']['stats']['total_handovers']}\n")
        output.write(f"# ping_pong_events,{payload['telemetry']['stats']['ping_pong_events']}\n")
        output.write(f"# ping_pong_reduction_pct,{payload['telemetry']['stats']['ping_pong_reduction_pct']}\n")
        output.write("#\n")

        if payload['tower_states']:
            writer = csv.DictWriter(output, fieldnames=payload['tower_states'][0].keys())
            writer.writeheader()
            writer.writerows(payload['tower_states'])

        csv_bytes = output.getvalue().encode('utf-8')
        ts = datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        return StreamingResponse(
            iter([csv_bytes]),
            media_type='text/csv',
            headers={'Content-Disposition': f'attachment; filename="server_export_{ts}.csv"'},
        )

    # Default: JSON
    return JSONResponse(content=payload)
