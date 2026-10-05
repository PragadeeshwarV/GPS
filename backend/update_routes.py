import urllib.request
import json
import math
import re

def fetch_route(coords):
    coords_str = ";".join([f"{lon},{lat}" for lon, lat in coords])
    url = f"http://router.project-osrm.org/route/v1/driving/{coords_str}?overview=full&geometries=geojson"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
        return data['routes'][0]['geometry']['coordinates']
    except Exception as e:
        print(f"Failed to fetch {url}: {e}")
        return []

def dist(a, b):
    # a, b are (lon, lat)
    dlat = (b[1]-a[1])*111000
    dlon = (b[0]-a[0])*108100*math.cos(math.radians((a[1]+b[1])/2))
    return math.sqrt(dlat**2+dlon**2)

def subsample(coords, min_dist_m=18):
    if not coords: return []
    out = [coords[0]]
    for p in coords[1:]:
        if dist(out[-1], p) >= min_dist_m:
            out.append(p)
    return out

# Define coordinates near 13.0827, 80.2707
# Poonamallee High Rd runs East/West. Let's make routes that follow the road.
ROUTES = {
    'ROUTE_A': [(80.2600, 13.0800), (80.2707, 13.0827), (80.2780, 13.0840)],  # West to East
    'ROUTE_B': [(80.2780, 13.0840), (80.2707, 13.0827), (80.2600, 13.0800)],  # East to West
    'ROUTE_C': [(80.2650, 13.0880), (80.2707, 13.0827), (80.2750, 13.0780)],  # North to South (approx)
    'ROUTE_D': [(80.2750, 13.0780), (80.2707, 13.0827), (80.2650, 13.0880)],  # South to North (approx)
    'ROUTE_E': [(80.2640, 13.0760), (80.2707, 13.0827), (80.2778, 13.0895)],  # South-West to North-East
}

print("Fetching and parsing routes...")
results_py = []
results_ts = []

for name, coords in ROUTES.items():
    raw = fetch_route(coords)
    sampled = subsample(raw, min_dist_m=18)
    
    # Python format
    py_waypoints = ",\n        ".join([f"({p[1]:.6f}, {p[0]:.6f})" for p in sampled])
    results_py.append(f"    # {name}\n    [\n        {py_waypoints}\n    ],")
    
    # TS format
    ts_waypoints = ",\n      ".join([f"[{p[1]:.6f}, {p[0]:.6f}]" for p in sampled])
    results_ts.append(f"  {name}: {{\n    label: '{name}',\n    description: 'Realistic route',\n    waypoints: [\n      {ts_waypoints}\n    ],\n  }},")

# Read and update backend/app/routers/simulation.py
with open("app/routers/simulation.py", "r", encoding="utf-8") as f:
    backend_content = f.read()

# Replace ROAD_ROUTES block
py_replacement = "ROAD_ROUTES: List[List[Waypoint]] = [\n" + "\n".join(results_py) + "\n]"
backend_content = re.sub(r'ROAD_ROUTES: List\[List\[Waypoint\]\] = \[\n(?:.*?)\n\]', py_replacement, backend_content, flags=re.DOTALL)

with open("app/routers/simulation.py", "w", encoding="utf-8") as f:
    f.write(backend_content)

# Read and update frontend/app/components/SimulatorPanel.tsx
with open("../frontend/app/components/SimulatorPanel.tsx", "r", encoding="utf-8") as f:
    frontend_content = f.read()

# Replace ROUTES block
ts_replacement = "const ROUTES: Record<RouteName, RouteConfig> = {\n" + "\n".join(results_ts) + "\n};"
frontend_content = re.sub(r'const ROUTES: Record<RouteName, RouteConfig> = \{\n(?:.*?)\n\};', ts_replacement, frontend_content, flags=re.DOTALL)

with open("../frontend/app/components/SimulatorPanel.tsx", "w", encoding="utf-8") as f:
    f.write(frontend_content)

print("Updated simulation.py and SimulatorPanel.tsx with new realistic routes based on actual center coordinates.")
