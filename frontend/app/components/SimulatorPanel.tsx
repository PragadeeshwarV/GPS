'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Square, RotateCcw, ChevronDown } from 'lucide-react';
import { TelemetryPayload } from '../hooks/useTelemetry';

// ── Constants ────────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 500;
const SPEED_KMH        = 30;
const SPEED_MPS        = SPEED_KMH / 3.6;   // ~8.33 m/s — city traffic
const HEADING_ALPHA    = 0.25;               // smoothing: 0=instant, 1=frozen

// ── Waypoint types ───────────────────────────────────────────────────────────

type WP = [number, number]; // [lat, lon]

interface RouteConfig {
  label: string;
  description: string;
  waypoints: WP[];
}

// ── Road routes ──────────────────────────────────────────────────────────────
// Hand-crafted GPS waypoints traced along real streets around the
// Nandanam / Anna Salai / Dr Radhakrishnan Salai intersection, Chennai.
// Center intersection: 13.0827°N, 80.2707°E

export type RouteName = 'ROUTE_A' | 'ROUTE_B' | 'ROUTE_C' | 'ROUTE_D' | 'ROUTE_E';

const ROUTES: Record<RouteName, RouteConfig> = {
  ROUTE_A: {
    label: 'ROUTE_A',
    description: 'Realistic route',
    waypoints: [
      [13.080141, 80.259616],
      [13.079534, 80.259379],
      [13.079587, 80.260108],
      [13.079714, 80.260756],
      [13.079756, 80.260927],
      [13.079974, 80.261502],
      [13.080061, 80.261722],
      [13.080113, 80.261887],
      [13.080295, 80.262785],
      [13.080557, 80.263972],
      [13.080784, 80.265167],
      [13.080804, 80.265395],
      [13.080779, 80.266937],
      [13.080766, 80.267477],
      [13.080770, 80.268009],
      [13.080785, 80.268574],
      [13.080790, 80.268893],
      [13.080802, 80.269406],
      [13.080827, 80.270171],
      [13.080841, 80.270475],
      [13.080862, 80.270672],
      [13.080927, 80.270857],
      [13.081172, 80.270882],
      [13.081441, 80.270848],
      [13.081803, 80.270794],
      [13.082533, 80.270699],
      [13.082697, 80.270678],
      [13.083069, 80.270630],
      [13.083315, 80.270592],
      [13.081745, 80.270875],
      [13.081473, 80.270911],
      [13.081272, 80.270948],
      [13.081145, 80.271072],
      [13.081102, 80.271268],
      [13.081135, 80.271450],
      [13.081177, 80.271623],
      [13.081237, 80.271916],
      [13.081276, 80.272100],
      [13.081303, 80.272293],
      [13.081332, 80.272491],
      [13.081395, 80.272802],
      [13.081441, 80.272994],
      [13.081495, 80.273280],
      [13.081557, 80.273591],
      [13.081631, 80.273956],
      [13.081676, 80.274535],
      [13.081694, 80.274741],
      [13.081708, 80.275054],
      [13.081732, 80.275277],
      [13.081723, 80.275458],
      [13.081750, 80.275782],
      [13.081814, 80.276053],
      [13.081898, 80.276318],
      [13.081921, 80.276499],
      [13.082092, 80.277850],
      [13.082261, 80.278016],
      [13.083026, 80.278091],
      [13.083387, 80.278119],
      [13.083581, 80.278094],
      [13.084061, 80.278130]
    ],
  },
  ROUTE_B: {
    label: 'ROUTE_B',
    description: 'Realistic route',
    waypoints: [
      [13.084071, 80.278006],
      [13.085358, 80.278308],
      [13.085280, 80.278642],
      [13.085171, 80.279108],
      [13.084709, 80.279053],
      [13.084035, 80.279003],
      [13.083655, 80.278957],
      [13.083468, 80.278980],
      [13.083249, 80.278957],
      [13.082945, 80.278820],
      [13.082767, 80.278739],
      [13.082166, 80.278467],
      [13.082020, 80.278227],
      [13.081996, 80.278006],
      [13.081935, 80.277489],
      [13.081782, 80.276353],
      [13.081710, 80.276052],
      [13.081647, 80.275669],
      [13.081632, 80.275494],
      [13.081621, 80.275157],
      [13.081595, 80.274799],
      [13.081529, 80.274008],
      [13.081404, 80.273391],
      [13.081254, 80.272628],
      [13.081142, 80.271934],
      [13.081052, 80.271539],
      [13.080987, 80.271285],
      [13.080936, 80.271092],
      [13.080963, 80.270919],
      [13.081172, 80.270882],
      [13.081441, 80.270848],
      [13.081803, 80.270794],
      [13.082533, 80.270699],
      [13.082697, 80.270678],
      [13.083069, 80.270630],
      [13.083315, 80.270592],
      [13.081745, 80.270875],
      [13.081473, 80.270911],
      [13.081272, 80.270948],
      [13.081145, 80.271072],
      [13.081102, 80.271268],
      [13.081135, 80.271450],
      [13.081177, 80.271623],
      [13.081237, 80.271916],
      [13.081276, 80.272100],
      [13.081303, 80.272293],
      [13.081332, 80.272491],
      [13.081395, 80.272802],
      [13.081441, 80.272994],
      [13.081495, 80.273280],
      [13.081557, 80.273591],
      [13.081631, 80.273956],
      [13.081404, 80.273391],
      [13.081254, 80.272628],
      [13.081142, 80.271934],
      [13.081052, 80.271539],
      [13.080987, 80.271285],
      [13.080936, 80.271092],
      [13.080838, 80.270877],
      [13.080783, 80.270640],
      [13.080772, 80.270454],
      [13.080764, 80.270198],
      [13.080672, 80.268022],
      [13.080680, 80.266998],
      [13.080711, 80.265407],
      [13.080692, 80.265233],
      [13.080611, 80.264789],
      [13.080451, 80.264025],
      [13.080256, 80.263126],
      [13.080190, 80.262826],
      [13.080146, 80.262595],
      [13.080023, 80.261960],
      [13.079827, 80.261432],
      [13.079695, 80.261110],
      [13.079633, 80.260945],
      [13.079506, 80.260326],
      [13.079412, 80.259556],
      [13.079319, 80.258789],
      [13.079500, 80.259366],
      [13.080141, 80.259616]
    ],
  },
  ROUTE_C: {
    label: 'ROUTE_C',
    description: 'Realistic route',
    waypoints: [
      [13.088001, 80.265016],
      [13.087762, 80.265118],
      [13.087695, 80.265719],
      [13.087600, 80.265922],
      [13.087400, 80.265920],
      [13.086771, 80.265878],
      [13.085440, 80.265701],
      [13.085371, 80.266155],
      [13.085304, 80.266605],
      [13.085277, 80.266776],
      [13.084252, 80.266787],
      [13.084047, 80.266767],
      [13.083757, 80.266778],
      [13.083502, 80.266787],
      [13.083292, 80.266807],
      [13.083101, 80.266831],
      [13.082907, 80.266856],
      [13.082636, 80.266873],
      [13.082296, 80.266875],
      [13.081116, 80.266924],
      [13.080779, 80.266937],
      [13.080766, 80.267477],
      [13.080770, 80.268009],
      [13.080785, 80.268574],
      [13.080790, 80.268893],
      [13.080802, 80.269406],
      [13.080827, 80.270171],
      [13.080841, 80.270475],
      [13.080862, 80.270672],
      [13.080927, 80.270857],
      [13.081172, 80.270882],
      [13.081441, 80.270848],
      [13.081803, 80.270794],
      [13.082533, 80.270699],
      [13.082697, 80.270678],
      [13.083069, 80.270630],
      [13.083315, 80.270592],
      [13.081745, 80.270875],
      [13.081473, 80.270911],
      [13.081272, 80.270948],
      [13.081145, 80.271072],
      [13.081102, 80.271268],
      [13.081135, 80.271450],
      [13.081177, 80.271623],
      [13.081237, 80.271916],
      [13.081276, 80.272100],
      [13.081303, 80.272293],
      [13.081332, 80.272491],
      [13.081395, 80.272802],
      [13.081441, 80.272994],
      [13.081495, 80.273280],
      [13.081557, 80.273591],
      [13.081631, 80.273956],
      [13.081676, 80.274535],
      [13.081694, 80.274741],
      [13.081708, 80.275054],
      [13.081732, 80.275277],
      [13.081723, 80.275458],
      [13.081750, 80.275782],
      [13.081814, 80.276053],
      [13.081898, 80.276318],
      [13.081921, 80.276499],
      [13.082092, 80.277850],
      [13.082166, 80.278467],
      [13.082020, 80.278227],
      [13.081996, 80.278006],
      [13.081935, 80.277489],
      [13.081782, 80.276353],
      [13.081710, 80.276052],
      [13.081647, 80.275669],
      [13.081632, 80.275494],
      [13.081531, 80.275310],
      [13.080844, 80.275272],
      [13.080229, 80.275339],
      [13.080057, 80.275359],
      [13.079867, 80.275373],
      [13.079665, 80.275362],
      [13.079484, 80.275334],
      [13.079284, 80.275291],
      [13.078977, 80.275216],
      [13.078786, 80.275202],
      [13.078576, 80.275278],
      [13.078449, 80.275397],
      [13.078348, 80.275602],
      [13.078261, 80.275881],
      [13.078198, 80.276057],
      [13.078013, 80.276212],
      [13.077754, 80.276235],
      [13.077212, 80.276259],
      [13.077597, 80.276115],
      [13.077868, 80.276093],
      [13.078032, 80.276009],
      [13.078207, 80.275496],
      [13.078303, 80.275262],
      [13.078435, 80.275136],
      [13.078381, 80.274946]
    ],
  },
  ROUTE_D: {
    label: 'ROUTE_D',
    description: 'Realistic route',
    waypoints: [
      [13.078374, 80.274914],
      [13.078435, 80.275136],
      [13.078303, 80.275262],
      [13.078207, 80.275496],
      [13.078079, 80.275939],
      [13.077965, 80.276064],
      [13.077657, 80.276112],
      [13.077160, 80.276134],
      [13.077834, 80.276150],
      [13.078001, 80.276117],
      [13.078133, 80.275988],
      [13.078214, 80.275726],
      [13.078274, 80.275557],
      [13.078352, 80.275389],
      [13.078479, 80.275245],
      [13.078659, 80.275146],
      [13.078844, 80.275121],
      [13.079084, 80.275157],
      [13.079509, 80.275253],
      [13.079723, 80.275289],
      [13.079931, 80.275292],
      [13.080138, 80.275273],
      [13.081429, 80.275141],
      [13.081621, 80.275157],
      [13.081595, 80.274799],
      [13.081529, 80.274008],
      [13.081404, 80.273391],
      [13.081254, 80.272628],
      [13.081142, 80.271934],
      [13.081052, 80.271539],
      [13.080987, 80.271285],
      [13.080936, 80.271092],
      [13.080963, 80.270919],
      [13.081172, 80.270882],
      [13.081441, 80.270848],
      [13.081803, 80.270794],
      [13.082533, 80.270699],
      [13.082697, 80.270678],
      [13.083069, 80.270630],
      [13.083315, 80.270592],
      [13.083963, 80.270496],
      [13.084182, 80.270465],
      [13.084343, 80.270321],
      [13.084553, 80.269813],
      [13.084703, 80.269481],
      [13.084786, 80.269174],
      [13.084890, 80.268682],
      [13.084911, 80.268501],
      [13.084918, 80.268223],
      [13.084924, 80.267914],
      [13.084963, 80.267715],
      [13.085216, 80.266779],
      [13.085244, 80.266594],
      [13.085285, 80.266299],
      [13.085367, 80.265691],
      [13.086634, 80.265868],
      [13.087400, 80.265920],
      [13.087600, 80.265922],
      [13.087695, 80.265719],
      [13.087762, 80.265118],
      [13.088001, 80.265016]
    ],
  },
  ROUTE_E: {
    label: 'ROUTE_E',
    description: 'Realistic route',
    waypoints: [
      [13.075897, 80.264127],
      [13.076097, 80.264202],
      [13.076370, 80.264169],
      [13.076597, 80.264150],
      [13.076597, 80.264669],
      [13.076472, 80.265265],
      [13.076626, 80.265365],
      [13.076840, 80.265426],
      [13.077146, 80.265496],
      [13.077340, 80.265510],
      [13.077595, 80.265491],
      [13.077996, 80.265441],
      [13.078501, 80.265384],
      [13.078843, 80.265338],
      [13.079109, 80.265293],
      [13.080374, 80.265148],
      [13.080679, 80.265132],
      [13.080804, 80.265395],
      [13.080779, 80.266937],
      [13.080766, 80.267477],
      [13.080770, 80.268009],
      [13.080785, 80.268574],
      [13.080790, 80.268893],
      [13.080802, 80.269406],
      [13.080827, 80.270171],
      [13.080841, 80.270475],
      [13.080862, 80.270672],
      [13.080927, 80.270857],
      [13.081172, 80.270882],
      [13.081441, 80.270848],
      [13.081803, 80.270794],
      [13.082533, 80.270699],
      [13.082697, 80.270678],
      [13.083069, 80.270630],
      [13.083315, 80.270592],
      [13.081745, 80.270875],
      [13.081473, 80.270911],
      [13.081272, 80.270948],
      [13.081145, 80.271072],
      [13.081102, 80.271268],
      [13.081135, 80.271450],
      [13.081177, 80.271623],
      [13.081237, 80.271916],
      [13.081276, 80.272100],
      [13.081303, 80.272293],
      [13.081332, 80.272491],
      [13.081395, 80.272802],
      [13.081441, 80.272994],
      [13.081495, 80.273280],
      [13.081557, 80.273591],
      [13.081631, 80.273956],
      [13.081676, 80.274535],
      [13.081694, 80.274741],
      [13.081708, 80.275054],
      [13.081732, 80.275277],
      [13.081723, 80.275458],
      [13.081750, 80.275782],
      [13.081814, 80.276053],
      [13.081956, 80.276240],
      [13.082306, 80.276240],
      [13.082571, 80.276207],
      [13.082862, 80.276169],
      [13.085088, 80.275872],
      [13.086639, 80.275675],
      [13.087058, 80.275654],
      [13.088040, 80.275540],
      [13.088307, 80.275509],
      [13.089201, 80.275391],
      [13.089942, 80.275293],
      [13.090659, 80.275218],
      [13.091420, 80.275204],
      [13.090376, 80.275339],
      [13.089929, 80.275395],
      [13.089477, 80.275437],
      [13.089254, 80.275461],
      [13.089032, 80.275484],
      [13.088508, 80.275549],
      [13.088664, 80.276612],
      [13.088777, 80.276736],
      [13.088940, 80.276960],
      [13.089069, 80.277234],
      [13.089162, 80.277407],
      [13.089386, 80.277662]
    ],
  },
};

// ── Geometry helpers ─────────────────────────────────────────────────────────

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dlat = lat2 - lat1;
  const dlon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const angle = Math.atan2(dlon, dlat) * (180 / Math.PI);
  return (angle + 360) % 360;
}

function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dlat = (lat2 - lat1) * 111_000;
  const dlon = (lon2 - lon1) * 108_100 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.sqrt(dlat * dlat + dlon * dlon);
}

function smoothHeading(current: number, target: number, alpha: number): number {
  const diff = ((target - current + 180) % 360) - 180;
  return (current + (1 - alpha) * diff + 360) % 360;
}

// ── Waypoint walker state ─────────────────────────────────────────────────────

interface WalkerState {
  lat: number;
  lon: number;
  heading: number;
  segIdx: number;
  done: boolean;
}

function advanceWalker(
  state: WalkerState,
  waypoints: WP[],
  speedMps: number,
  dtSec: number
): WalkerState {
  let { lat, lon, heading, segIdx } = state;
  let remaining = speedMps * dtSec;

  while (remaining > 0 && segIdx < waypoints.length - 1) {
    const [nxLat, nxLon] = waypoints[segIdx + 1];
    const segBearing = bearing(lat, lon, nxLat, nxLon);
    const segDist    = distM(lat, lon, nxLat, nxLon);

    if (remaining >= segDist) {
      remaining -= segDist;
      lat = nxLat;
      lon = nxLon;
      segIdx++;
      heading = smoothHeading(heading, segBearing, HEADING_ALPHA);
    } else {
      const frac = segDist > 0 ? remaining / segDist : 0;
      lat += frac * (nxLat - lat);
      lon += frac * (nxLon - lon);
      heading = smoothHeading(heading, segBearing, HEADING_ALPHA);
      remaining = 0;
    }
  }

  const done = segIdx >= waypoints.length - 1;
  return { lat, lon, heading, segIdx, done };
}

// ── Props ────────────────────────────────────────────────────────────────────

interface SimulatorPanelProps {
  send: (payload: TelemetryPayload) => void;
  isConnected: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SimulatorPanel({ send, isConnected }: SimulatorPanelProps) {
  const [selectedRoute, setSelectedRoute] = useState<RouteName>('ROUTE_A');
  const [isPlaying, setIsPlaying]         = useState(false);
  const [tick, setTick]                   = useState(0);
  const [dropdownOpen, setDropdownOpen]   = useState(false);
  const [simUser, setSimUser]             = useState<string>('USER-01');

  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const walkerRef    = useRef<WalkerState>({ lat: 0, lon: 0, heading: 0, segIdx: 0, done: false });

  const stopSim = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPlaying(false);
    setTick(0);
  }, []);

  const startSim = useCallback(() => {
    if (!isConnected) return;
    const route = ROUTES[selectedRoute];
    const [startLat, startLon] = route.waypoints[0];
    const initHeading = route.waypoints.length > 1
      ? bearing(startLat, startLon, route.waypoints[1][0], route.waypoints[1][1])
      : 0;

    walkerRef.current = {
      lat: startLat, lon: startLon,
      heading: initHeading,
      segIdx: 0, done: false,
    };

    let localTick = 0;
    setTick(0);
    setIsPlaying(true);

    intervalRef.current = setInterval(() => {
      const { lat, lon, heading } = walkerRef.current;

      send({ lat, lon, heading: Math.round(heading), speed: SPEED_KMH, source: 'desktop', user_id: simUser });
      localTick++;
      setTick(localTick);

      // Advance walker for next tick
      walkerRef.current = advanceWalker(
        walkerRef.current,
        route.waypoints,
        SPEED_MPS,
        TICK_INTERVAL_MS / 1000
      );

      // Loop when route is done
      if (walkerRef.current.done) {
        const [sLat, sLon] = route.waypoints[0];
        const initH = route.waypoints.length > 1
          ? bearing(sLat, sLon, route.waypoints[1][0], route.waypoints[1][1])
          : 0;
        walkerRef.current = { lat: sLat, lon: sLon, heading: initH, segIdx: 0, done: false };
      }
    }, TICK_INTERVAL_MS);
  }, [isConnected, selectedRoute, send, simUser]);

  // Stop sim when route changes mid-play
  useEffect(() => {
    if (isPlaying) stopSim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoute]);

  useEffect(() => () => stopSim(), [stopSim]);

  const routeKeys  = Object.keys(ROUTES) as RouteName[];
  const selected   = ROUTES[selectedRoute];
  const wp         = selected.waypoints;
  const approxHdg  = wp.length > 1
    ? Math.round(bearing(wp[0][0], wp[0][1], wp[1][0], wp[1][1]))
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Target User Selector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 9, color: '#64748b', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Simulated Vehicle:
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['USER-01', 'USER-02', 'USER-03', 'USER-04', 'USER-05'].map((uid) => (
            <button
              key={uid}
              onClick={() => setSimUser(uid)}
              style={{
                flex: 1,
                padding: '4px 0',
                fontSize: 9,
                fontWeight: 600,
                fontFamily: 'JetBrains Mono, monospace',
                borderRadius: 4,
                border: simUser === uid ? '1px solid #38bdf8' : '1px solid rgba(56,189,248,0.15)',
                background: simUser === uid ? 'rgba(56,189,248,0.2)' : 'rgba(15,23,42,0.6)',
                color: simUser === uid ? '#38bdf8' : '#64748b',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {uid.replace('USER-', 'U')}
            </button>
          ))}
        </div>
      </div>

      {/* Route selector */}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setDropdownOpen((v) => !v)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(56,189,248,0.06)',
            border: '1px solid rgba(56,189,248,0.2)',
            color: '#e2e8f0', cursor: 'pointer',
            fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
            transition: 'border-color 0.2s',
          }}
        >
          <span>{selected.label}</span>
          <ChevronDown size={13} style={{ color: '#38bdf8', transform: dropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>

        {dropdownOpen && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
            background: 'rgba(8,16,32,0.98)', border: '1px solid rgba(56,189,248,0.25)',
            borderRadius: 8, marginTop: 4, overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          }}>
            {routeKeys.map((key) => (
              <button
                key={key}
                onClick={() => { setSelectedRoute(key); setDropdownOpen(false); }}
                style={{
                  width: '100%', padding: '9px 12px', textAlign: 'left',
                  background: key === selectedRoute ? 'rgba(56,189,248,0.1)' : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid rgba(56,189,248,0.06)',
                  color: key === selectedRoute ? '#38bdf8' : '#94a3b8',
                  cursor: 'pointer', fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                  display: 'flex', flexDirection: 'column', gap: 2,
                  transition: 'background 0.15s',
                }}
              >
                <span style={{ fontWeight: 600 }}>{ROUTES[key].label}</span>
                <span style={{ fontSize: 9, color: '#475569' }}>{ROUTES[key].description}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 10, color: '#475569', fontFamily: 'JetBrains Mono, monospace' }}>
          {isPlaying
            ? <span style={{ color: '#00ff88' }}>● TICK {String(tick).padStart(4, '0')} · {SPEED_KMH} km/h</span>
            : <span>Init hdg: {approxHdg}° · {SPEED_KMH} km/h · road-following</span>}
        </div>
        {!isConnected && (
          <span style={{ fontSize: 9, color: '#ef4444' }}>NO WS</span>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8 }}>
        {!isPlaying ? (
          <button
            onClick={startSim}
            disabled={!isConnected}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '9px 0', borderRadius: 8,
              background: isConnected
                ? 'linear-gradient(135deg, rgba(0,255,136,0.2), rgba(56,189,248,0.15))'
                : 'rgba(30,41,59,0.5)',
              border: `1px solid ${isConnected ? 'rgba(0,255,136,0.4)' : 'rgba(51,65,85,0.4)'}`,
              color: isConnected ? '#00ff88' : '#475569',
              cursor: isConnected ? 'pointer' : 'not-allowed',
              fontSize: 12, fontWeight: 600,
              fontFamily: 'JetBrains Mono, monospace',
              letterSpacing: '0.06em',
              transition: 'all 0.2s',
            }}
          >
            <Play size={13} />
            PLAY
          </button>
        ) : (
          <>
            <button
              onClick={stopSim}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '9px 0', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)',
                background: 'rgba(239,68,68,0.1)',
                color: '#ef4444', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.06em', transition: 'all 0.2s',
              }}
            >
              <Square size={12} fill="#ef4444" />
              STOP
            </button>
            <button
              onClick={() => { stopSim(); setTimeout(startSim, 50); }}
              title="Restart route"
              style={{
                padding: '9px 12px', borderRadius: 8,
                border: '1px solid rgba(56,189,248,0.2)',
                background: 'rgba(56,189,248,0.06)',
                color: '#38bdf8', cursor: 'pointer', transition: 'all 0.2s',
              }}
            >
              <RotateCcw size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
