'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Signal, Navigation, Activity, AlertTriangle,
  TrendingUp, Gauge, Radio, Smartphone, Monitor,
  Download, FileJson, FileText, WifiOff, AlertCircle,
  ChevronLeft, ChevronRight, Users,
} from 'lucide-react';
import { useSimulation } from './hooks/useSimulation';
import { useTelemetry } from './hooks/useTelemetry';
import { useMultiSimulation } from './hooks/useMultiSimulation';
import { SimulationData, Tower, TowerStatus, MultiUserState, MultiLogEntry } from './types/simulation';
import SimulatorPanel from './components/SimulatorPanel';

const SimulationMap = dynamic(() => import('./components/SimulationMap'), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: '#0c1424' }}>
      <div style={{ textAlign: 'center', color: '#38bdf8' }}>
        <div style={{ fontSize: 12, fontFamily: 'monospace', marginBottom: 4, opacity: 0.6 }}>INITIALISING MAP</div>
        <div style={{ fontSize: 11, color: '#3d5a78' }}>Loading tile engine…</div>
      </div>
    </div>
  ),
});

// ── Types ────────────────────────────────────────────────────────────────────

type AppMode = 'demo' | 'live';
type LiveSubMode = 'desktop' | 'mobile';

/** Five fixed user IDs */
const USER_IDS = ['USER-01', 'USER-02', 'USER-03', 'USER-04', 'USER-05'] as const;
type UserId = typeof USER_IDS[number];
type UserSelection = 'ALL' | UserId;

/** Per-user label colors matching SimulationMap */
const USER_COLORS: Record<string, string> = {
  'USER-01': '#facc15',
  'USER-02': '#f87171',
  'USER-03': '#4ade80',
  'USER-04': '#a78bfa',
  'USER-05': '#38bdf8',
  user_1: '#facc15',
  user_2: '#f87171',
  user_3: '#4ade80',
  user_4: '#a78bfa',
  user_5: '#38bdf8',
};

function matchUser(user: MultiUserState, targetId: string): boolean {
  const uNorm = user.user_id.toUpperCase().replace('_', '-');
  const tNorm = targetId.toUpperCase().replace('_', '-');
  return uNorm === tNorm || uNorm.includes(tNorm) || tNorm.includes(uNorm);
}

interface LogEntry {
  timestamp: string;
  tick: number;
  event: 'HANDOVER' | 'CLEAR' | 'TICK';
  predicted_path: string | null;
  confidence: number;
  distance_m: number;
  heading: number;
  speed_kmh: number;
  lat: number;
  lon: number;
  active_tower: string | null;
  handover_count: number;
  ping_pong_events: number;
  ping_pong_reduction_pct: number;
  latency_ms: number;
  throughput_mbps: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function towerStatusClass(status: TowerStatus): string {
  if (status === 'BEAMFORMED_ACTIVE') return 'badge-green';
  if (status === 'CONNECTED') return 'badge-cyan';
  if (status === 'SUPPRESSED') return 'badge-red';
  return 'badge-muted';
}

function towerStatusColor(status: TowerStatus): string {
  if (status === 'BEAMFORMED_ACTIVE') return '#00ff88';
  if (status === 'CONNECTED') return '#38bdf8';
  if (status === 'SUPPRESSED') return '#ef4444';
  return '#475569';
}

function headingLabel(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionTitle({ icon, label, badge }: { icon: React.ReactNode; label: string; badge?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <div style={{ color: '#38bdf8', display: 'flex' }}>{icon}</div>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: '#7fa8c9', textTransform: 'uppercase', fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </span>
      {badge}
    </div>
  );
}

function MetricRow({ label, value, unit, color }: { label: string; value: string | number; unit?: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ fontSize: 11, color: '#475569' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: color ?? '#e2e8f0', fontFamily: 'JetBrains Mono, monospace' }}>
        {value}{unit && <span style={{ color: '#475569', fontWeight: 400, marginLeft: 2 }}>{unit}</span>}
      </span>
    </div>
  );
}

function TowerRow({ tower }: { tower: Tower }) {
  const color = towerStatusColor(tower.status);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', borderBottom: '1px solid rgba(56,189,248,0.06)' }}>
      <div style={{
        width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
        boxShadow: tower.status !== 'SUPPRESSED' ? `0 0 6px ${color}` : 'none',
        opacity: tower.status === 'SUPPRESSED' ? 0.4 : 1,
        transition: 'all 0.4s ease',
      }} />
      <span style={{ fontSize: 10, color: '#94a3b8', flex: 1, fontFamily: 'JetBrains Mono, monospace' }}>
        {tower.id.replace('TOWER_', 'TWR-')} · {tower.frequency_band}
      </span>
      <span className={`badge ${towerStatusClass(tower.status)}`} style={{ fontSize: 9 }}>
        {tower.status === 'BEAMFORMED_ACTIVE' ? 'BEAM' : tower.status.slice(0, 4)}
      </span>
      <span style={{ fontSize: 10, color: '#475569', fontFamily: 'JetBrains Mono, monospace', minWidth: 42, textAlign: 'right' }}>
        {tower.allocated_power_dbm} dBm
      </span>
    </div>
  );
}

/** LEFT/RIGHT control buttons for one user */
function UserSteerControls({
  userId,
  color,
  sendControl,
  isSelected = false,
}: {
  userId: string;
  color: string;
  sendControl: (uid: string, action: 'left' | 'right') => void;
  isSelected?: boolean;
}) {
  const btnStyle = (side: 'left' | 'right'): React.CSSProperties => ({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '5px 0',
    borderRadius: 6,
    background: `rgba(${side === 'left' ? '56,189,248' : '250,204,21'},0.08)`,
    border: `1px solid ${side === 'left' ? 'rgba(56,189,248,0.25)' : 'rgba(250,204,21,0.25)'}`,
    color: side === 'left' ? '#38bdf8' : '#facc15',
    cursor: 'pointer',
    fontSize: 10,
    fontFamily: 'JetBrains Mono, monospace',
    fontWeight: 700,
    letterSpacing: '0.05em',
    transition: 'all 0.15s',
  });

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: isSelected ? '4px 6px' : '2px 0',
      borderRadius: 6,
      background: isSelected ? 'rgba(56,189,248,0.06)' : 'transparent',
    }}>
      <div style={{
        width: 9, height: 9, borderRadius: '50%',
        background: color, flexShrink: 0,
        boxShadow: `0 0 6px ${color}`,
      }} />
      <span style={{ fontSize: 10, color, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, minWidth: 54 }}>
        {userId}
      </span>
      <div style={{ display: 'flex', flex: 1, gap: 4 }}>
        <button style={btnStyle('left')} onClick={() => sendControl(userId, 'left')}>
          <ChevronLeft size={11} /> LEFT
        </button>
        <button style={btnStyle('right')} onClick={() => sendControl(userId, 'right')}>
          RIGHT <ChevronRight size={11} />
        </button>
      </div>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [appMode, setAppMode] = useState<AppMode>('demo');
  const [liveSubMode, setLiveSubMode] = useState<LiveSubMode>('desktop');
  const [selectedUser, setSelectedUser] = useState<UserSelection>('ALL');
  const [logCount, setLogCount] = useState(0);
  const [isStale, setIsStale] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Per-user multi-log for demo mode
  const multiLogRef = useRef<MultiLogEntry[]>([]);
  const prevHandoverRef = useRef<Record<string, boolean>>({});

  // Single-user log for live mode
  const singleLogRef = useRef<LogEntry[]>([]);
  const prevSingleHandoverRef = useRef<boolean>(false);

  const lastUpdateRef = useRef<number>(Date.now());

  const { data: simData, isConnected: simConnected, error: simError } = useSimulation();
  const {
    data: multiData,
    isConnected: multiConnected,
    error: multiError,
    sendControl,
    resetAll,
  } = useMultiSimulation();
  const { data: telData, isConnected: telConnected, error: telError, send } = useTelemetry();

  // In demo mode, use multi-user data. In live mode, use single telemetry.
  const isConnected = appMode === 'demo' ? multiConnected : telConnected;
  const wsError = appMode === 'demo' ? multiError : telError;

  const multiUsers: MultiUserState[] = Array.isArray(multiData?.users)
    ? multiData.users
    : Object.values(multiData?.users ?? {});

  // Selected user's state (multi-user demo mode)
  const selectedUserState: MultiUserState | null =
    appMode === 'demo' && selectedUser !== 'ALL'
      ? (multiUsers.find((u) => matchUser(u, selectedUser)) ?? multiUsers[0] ?? null)
      : null;

  // Fleet aggregations for ALL USERS mode
  const fleetTotalHandovers = multiUsers.reduce((acc, u) => acc + (u.towers?.stats?.total_handovers ?? 0), 0);
  const fleetPingPongEvents = multiUsers.reduce((acc, u) => acc + (u.towers?.stats?.ping_pong_events ?? 0), 0);
  const fleetAvgLatency = multiUsers.length > 0
    ? multiUsers.reduce((acc, u) => acc + (u.network?.latency_ms ?? 0), 0) / multiUsers.length
    : 0;
  const fleetTotalThroughput = multiUsers.reduce((acc, u) => acc + (u.network?.throughput_mbps ?? 0), 0);
  const fleetNaivePp = Math.max(fleetTotalHandovers * 0.35, 1);
  const fleetAvoided = Math.max(fleetNaivePp - fleetPingPongEvents, 0);
  const fleetReductionPct = fleetTotalHandovers > 0 ? Math.round((fleetAvoided / fleetNaivePp) * 100) : 0;

  // For live mode, keep using single-user data for backward compat
  const data: SimulationData | null = appMode === 'live' ? (telData ?? simData) : null;
  const dataSource = (data as Record<string, unknown>)?.source as string | undefined;

  // Derived values for the selected user (demo mode) or single data (live mode)
  const vehicle = appMode === 'demo' ? selectedUserState?.vehicle : data?.vehicle;
  const pred = appMode === 'demo' ? selectedUserState?.prediction : data?.prediction;
  const net = appMode === 'demo' ? selectedUserState?.network : data?.network;
  const towers = appMode === 'demo'
    ? (selectedUserState?.towers?.all_towers ? Object.values(selectedUserState.towers.all_towers) : [])
    : (data ? Object.values(data.towers.all_towers) : []);
  const handoverActive = appMode === 'demo'
    ? (selectedUserState?.towers?.handover_active ?? false)
    : (data?.towers.handover_active ?? false);
  const activeTower = appMode === 'demo'
    ? (selectedUserState?.towers?.active_tower ?? null)
    : (data?.towers.active_tower ?? null);
  const stats = appMode === 'demo'
    ? (selectedUserState?.towers?.stats ?? null)
    : (data?.towers.stats ?? null);

  // ── Stale data detection ──────────────────────────────────────────────────

  useEffect(() => {
    if (multiData || data) {
      lastUpdateRef.current = Date.now();
      setIsStale(false);
    }
  }, [multiData, data]);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsStale(isConnected && Date.now() - lastUpdateRef.current > 6000);
    }, 2000);
    return () => clearInterval(interval);
  }, [isConnected]);

  // ── Multi-user log accumulation (demo mode) ───────────────────────────────

  useEffect(() => {
    if (appMode !== 'demo' || !multiData) return;

    let changed = false;
    for (const user of multiData.users) {
      const uid = user.user_id;
      const currentHandover = user.towers?.handover_active ?? false;
      const wasHandover = prevHandoverRef.current[uid] ?? false;

      let event: MultiLogEntry['event'] = 'TICK';
      if (currentHandover && !wasHandover) event = 'HANDOVER';
      else if (!currentHandover && wasHandover) event = 'CLEAR';
      prevHandoverRef.current[uid] = currentHandover;

      if (event !== 'TICK' || user.tick % 4 === 0) {
        const entry: MultiLogEntry = {
          user_id: uid,
          timestamp: multiData.timestamp,
          tick: user.tick,
          event,
          predicted_path: user.prediction.predicted_path,
          confidence: user.prediction.confidence,
          distance_m: user.prediction.distance_to_center_m,
          heading: user.vehicle.heading,
          speed_kmh: user.vehicle.speed_kmh,
          lat: user.vehicle.lat,
          lon: user.vehicle.lon,
          active_tower: user.towers?.active_tower?.id ?? null,
          handover_count: user.towers?.stats?.total_handovers ?? 0,
          ping_pong_events: user.towers?.stats?.ping_pong_events ?? 0,
          ping_pong_reduction_pct: user.towers?.stats?.ping_pong_reduction_pct ?? 0,
          latency_ms: user.network.latency_ms,
          throughput_mbps: user.network.throughput_mbps,
        };
        multiLogRef.current = [...multiLogRef.current.slice(-999), entry];
        changed = true;
      }
    }
    if (changed) setLogCount(multiLogRef.current.length);
  }, [multiData, appMode]);

  // ── Single-user log accumulation (live mode) ──────────────────────────────

  useEffect(() => {
    if (appMode !== 'live' || !data) return;

    const currentHandover = data.towers.handover_active;
    let event: LogEntry['event'] = 'TICK';
    if (currentHandover && !prevSingleHandoverRef.current) event = 'HANDOVER';
    else if (!currentHandover && prevSingleHandoverRef.current) event = 'CLEAR';
    prevSingleHandoverRef.current = currentHandover;

    if (event !== 'TICK' || data.tick % 4 === 0) {
      const entry: LogEntry = {
        timestamp: data.timestamp,
        tick: data.tick,
        event,
        predicted_path: data.prediction.predicted_path,
        confidence: data.prediction.confidence,
        distance_m: data.prediction.distance_to_center_m,
        heading: data.vehicle.heading,
        speed_kmh: data.vehicle.speed_kmh,
        lat: data.vehicle.lat,
        lon: data.vehicle.lon,
        active_tower: data.towers.active_tower?.id ?? null,
        handover_count: data.towers.stats.total_handovers,
        ping_pong_events: data.towers.stats.ping_pong_events,
        ping_pong_reduction_pct: data.towers.stats.ping_pong_reduction_pct,
        latency_ms: data.network.latency_ms,
        throughput_mbps: data.network.throughput_mbps,
      };
      singleLogRef.current = [...singleLogRef.current.slice(-499), entry];
      setLogCount(singleLogRef.current.length);
    }
  }, [data, appMode]);

  // Reset log count when switching mode
  useEffect(() => {
    setLogCount(appMode === 'demo' ? multiLogRef.current.length : singleLogRef.current.length);
  }, [appMode]);

  // ── Export functions ──────────────────────────────────────────────────────

  const exportJSON = useCallback(() => {
    if (appMode === 'demo') {
      const payload = {
        exported_at: new Date().toISOString(),
        mode: 'demo_multi_user',
        entry_count: multiLogRef.current.length,
        entries: multiLogRef.current,
      };
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `multi_handover_log_${Date.now()}.json`);
    } else {
      const payload = {
        exported_at: new Date().toISOString(),
        mode: 'live',
        entry_count: singleLogRef.current.length,
        entries: singleLogRef.current,
      };
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `handover_log_${Date.now()}.json`);
    }
    setExportMenuOpen(false);
  }, [appMode]);

  const exportCSV = useCallback(() => {
    if (appMode === 'demo') {
      const headers = [
        'user_id', 'timestamp', 'tick', 'event', 'predicted_path', 'confidence',
        'distance_m', 'heading', 'speed_kmh', 'lat', 'lon',
        'active_tower', 'handover_count', 'ping_pong_events',
        'ping_pong_reduction_pct', 'latency_ms', 'throughput_mbps',
      ];
      const rows = multiLogRef.current.map((e) =>
        headers.map((h) => {
          const v = (e as Record<string, unknown>)[h];
          return v === null || v === undefined ? '' : String(v);
        }).join(',')
      );
      const csv = [headers.join(','), ...rows].join('\n');
      downloadBlob(new Blob([csv], { type: 'text/csv' }), `multi_handover_log_${Date.now()}.csv`);
    } else {
      const headers = [
        'timestamp', 'tick', 'event', 'predicted_path', 'confidence',
        'distance_m', 'heading', 'speed_kmh', 'lat', 'lon',
        'active_tower', 'handover_count', 'ping_pong_events',
        'ping_pong_reduction_pct', 'latency_ms', 'throughput_mbps',
      ];
      const rows = singleLogRef.current.map((e) =>
        headers.map((h) => {
          const v = (e as Record<string, unknown>)[h];
          return v === null || v === undefined ? '' : String(v);
        }).join(',')
      );
      const csv = [headers.join(','), ...rows].join('\n');
      downloadBlob(new Blob([csv], { type: 'text/csv' }), `handover_log_${Date.now()}.csv`);
    }
    setExportMenuOpen(false);
  }, [appMode]);

  // Current tick label (for header)
  const currentTick = appMode === 'demo'
    ? (selectedUserState?.tick ?? multiData?.users?.[0]?.tick ?? null)
    : data?.tick ?? null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-deep)', overflow: 'hidden' }}>

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <header className="glass-panel" style={{
        padding: '0 20px', height: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
        borderBottom: '1px solid rgba(56,189,248,0.15)',
        zIndex: 10, flexShrink: 0, gap: 16,
      }}>

        {/* Left — Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 200 }}>
          <Radio size={16} style={{ color: '#38bdf8', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#e2e8f0', lineHeight: 1.2 }}>
              PREDICTIVE 5G HANDOVER
            </div>
            <div style={{ fontSize: 8, color: '#3d5a78', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.1em' }}>
              SPATIAL TRAJECTORY · BEAMFORMING · 5 USERS
            </div>
          </div>
        </div>

        {/* Center — Mode toggle */}
        <div className="mode-toggle" id="mode-toggle-bar">
          <button
            id="btn-simulated-demo"
            className={`mode-toggle-btn ${appMode === 'demo' ? 'active' : 'inactive'}`}
            onClick={() => setAppMode('demo')}
            title="Simulated Demo Mode — five independent vehicle simulations"
          >
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
              background: appMode === 'demo' ? '#00ff88' : '#475569',
              boxShadow: appMode === 'demo' ? '0 0 6px #00ff88' : 'none',
              animation: appMode === 'demo' ? 'dot-blink 1.2s ease-in-out infinite' : 'none',
              marginRight: 6, verticalAlign: 'middle',
            }} />
            🖥 SIMULATED DEMO
          </button>
          <button
            id="btn-live-telemetry"
            className={`mode-toggle-btn ${appMode === 'live' ? 'active' : 'inactive'}`}
            onClick={() => setAppMode('live')}
            title="Live Telemetry Mode — real GPS data from device or simulator"
          >
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
              background: appMode === 'live' ? '#facc15' : '#475569',
              boxShadow: appMode === 'live' ? '0 0 6px #facc15' : 'none',
              animation: appMode === 'live' ? 'dot-blink 0.9s ease-in-out infinite' : 'none',
              marginRight: 6, verticalAlign: 'middle',
            }} />
            📡 LIVE TELEMETRY
          </button>
        </div>

        {/* Right — Status + Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 200, justifyContent: 'flex-end' }}>
          {currentTick != null && (
            <span style={{ fontSize: 9, color: '#3d5a78', fontFamily: 'JetBrains Mono, monospace' }}>
              #{currentTick.toString().padStart(4, '0')}
            </span>
          )}
          {appMode === 'demo' && multiData && (
            <span className="badge badge-cyan" style={{ fontSize: 9 }}>
              👥 5 USERS
            </span>
          )}
          {appMode === 'live' && dataSource && (
            <span className={`badge ${dataSource === 'mobile' ? 'badge-amber' : 'badge-cyan'}`} style={{ fontSize: 9 }}>
              {dataSource === 'mobile' ? '📱 GPS' : '🖥 SIM'}
            </span>
          )}

          {/* Export dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              className="export-btn"
              onClick={() => setExportMenuOpen((v) => !v)}
              title="Export Handover Logs"
            >
              <Download size={11} />
              EXPORT
              {logCount > 0 && (
                <span className="log-pill">{logCount}</span>
              )}
            </button>

            {exportMenuOpen && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 6,
                background: 'rgba(8,16,32,0.98)', border: '1px solid rgba(56,189,248,0.25)',
                borderRadius: 10, overflow: 'hidden', zIndex: 100,
                boxShadow: '0 8px 32px rgba(0,0,0,0.7)', minWidth: 180,
              }}>
                <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid rgba(56,189,248,0.1)' }}>
                  <span style={{ fontSize: 9, color: '#475569', fontFamily: 'JetBrains Mono, monospace' }}>
                    {logCount} entries recorded
                    {appMode === 'demo' && ' · all 5 users · user_id col included'}
                  </span>
                </div>
                <button
                  onClick={exportJSON}
                  disabled={logCount === 0}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', background: 'transparent',
                    border: 'none', borderBottom: '1px solid rgba(56,189,248,0.08)',
                    color: logCount > 0 ? '#e2e8f0' : '#3d5a78',
                    cursor: logCount > 0 ? 'pointer' : 'not-allowed',
                    fontSize: 12, textAlign: 'left',
                  }}
                >
                  <FileJson size={14} style={{ color: '#facc15' }} />
                  Export as JSON
                </button>
                <button
                  onClick={exportCSV}
                  disabled={logCount === 0}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', background: 'transparent',
                    border: 'none',
                    color: logCount > 0 ? '#e2e8f0' : '#3d5a78',
                    cursor: logCount > 0 ? 'pointer' : 'not-allowed',
                    fontSize: 12, textAlign: 'left',
                  }}
                >
                  <FileText size={14} style={{ color: '#00ff88' }} />
                  Export as CSV
                </button>
              </div>
            )}
          </div>

          {/* Connection status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div className="live-dot" style={{ background: isConnected ? '#00ff88' : '#ef4444' }} />
            <span style={{ fontSize: 10, color: isConnected ? '#00ff88' : '#ef4444', fontFamily: 'JetBrains Mono, monospace' }}>
              {isConnected ? 'LIVE' : 'RECONNECT'}
            </span>
          </div>
        </div>
      </header>

      {/* ══ BODY ════════════════════════════════════════════════════════════ */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Map ──────────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* Map shows multiData in demo mode, single data in live mode */}
          <SimulationMap
            data={appMode === 'live' ? data : null}
            multiData={appMode === 'demo' ? multiData : null}
            selectedUser={selectedUser}
          />

          {/* 50m zone label */}
          <div style={{
            position: 'absolute', bottom: 16, left: 16, zIndex: 800,
            padding: '6px 12px', borderRadius: 8,
            background: 'rgba(5,9,15,0.85)', border: '1px solid rgba(245,158,11,0.3)',
            backdropFilter: 'blur(8px)',
          }}>
            <span style={{ fontSize: 9, color: '#f59e0b', letterSpacing: '0.1em', fontFamily: 'JetBrains Mono, monospace' }}>
              ◎  50 m HANDOVER ZONE
            </span>
          </div>

          {/* Distance readout */}
          {selectedUserState ? (
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 800, padding: '6px 16px', borderRadius: 8,
              background: 'rgba(5,9,15,0.85)', border: '1px solid var(--border)',
              backdropFilter: 'blur(8px)',
            }}>
              <span style={{ fontSize: 10, color: '#7fa8c9', fontFamily: 'JetBrains Mono, monospace' }}>
                Δ <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{selectedUserState.prediction.distance_to_center_m.toFixed(1)}</span> m to intersection
                <span style={{ color: USER_COLORS[selectedUser] || '#475569', marginLeft: 6, fontWeight: 700 }}>· {selectedUser}</span>
              </span>
            </div>
          ) : multiUsers.length > 0 && appMode === 'demo' ? (
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 800, padding: '6px 16px', borderRadius: 8,
              background: 'rgba(5,9,15,0.85)', border: '1px solid var(--border)',
              backdropFilter: 'blur(8px)',
            }}>
              <span style={{ fontSize: 10, color: '#7fa8c9', fontFamily: 'JetBrains Mono, monospace' }}>
                👥 <span style={{ color: '#00ff88', fontWeight: 700 }}>5 ACTIVE USERS</span> · Closest: <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                  {Math.min(...multiUsers.map((u) => u.prediction.distance_to_center_m)).toFixed(1)}
                </span> m to intersection
              </span>
            </div>
          ) : pred ? (
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 800, padding: '6px 16px', borderRadius: 8,
              background: 'rgba(5,9,15,0.85)', border: '1px solid var(--border)',
              backdropFilter: 'blur(8px)',
            }}>
              <span style={{ fontSize: 10, color: '#7fa8c9', fontFamily: 'JetBrains Mono, monospace' }}>
                Δ <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{pred.distance_to_center_m.toFixed(1)}</span> m to intersection
              </span>
            </div>
          ) : null}

          {/* Mobile wait overlay */}
          {appMode === 'live' && liveSubMode === 'mobile' && !data && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 900,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(5,9,15,0.65)', backdropFilter: 'blur(6px)',
            }}>
              <div style={{
                textAlign: 'center', padding: '28px 36px', borderRadius: 16,
                background: 'rgba(8,16,32,0.92)', border: '1px solid rgba(56,189,248,0.25)',
                boxShadow: '0 8px 48px rgba(0,0,0,0.6)', maxWidth: 340,
              }}>
                <Smartphone size={32} style={{ color: '#38bdf8', marginBottom: 12 }} />
                <p style={{ color: '#e2e8f0', fontWeight: 700, marginBottom: 6, fontSize: 14 }}>Waiting for mobile GPS</p>
                <p style={{ fontSize: 11, color: '#7fa8c9', marginBottom: 14, lineHeight: 1.5 }}>
                  Open this URL on your phone, grant location permission, and tap <strong style={{ color: '#00ff88' }}>START TRANSMITTING</strong>:
                </p>
                <code style={{ display: 'block', fontSize: 12, color: '#facc15', padding: '8px 12px', background: 'rgba(250,204,21,0.08)', borderRadius: 8, fontFamily: 'JetBrains Mono, monospace', border: '1px solid rgba(250,204,21,0.2)' }}>
                  http://localhost:3000/mobile
                </code>
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#475569', animation: 'dot-blink 1.5s ease-in-out infinite' }} />
                  <p style={{ fontSize: 10, color: '#475569', fontFamily: 'JetBrains Mono, monospace' }}>Dashboard streams live as you walk</p>
                </div>
              </div>
            </div>
          )}

          {/* Click outside export menu */}
          {exportMenuOpen && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setExportMenuOpen(false)} />
          )}
        </div>

        {/* ── Side Panel ──────────────────────────────────────────────────── */}
        <aside className="glass-panel" style={{
          width: 310, overflowY: 'auto', overflowX: 'hidden',
          padding: '14px', display: 'flex', flexDirection: 'column', gap: 12,
          borderTop: 'none', borderBottom: 'none', borderRight: 'none',
          borderLeft: '1px solid rgba(56,189,248,0.12)', flexShrink: 0,
        }}>

          {/* ── Error / Stale banners ─────────────────────────────────────── */}
          {!isConnected && (
            <div className="error-banner">
              <WifiOff size={13} />
              <span>WebSocket disconnected — reconnecting…</span>
            </div>
          )}
          {isConnected && isStale && (
            <div className="warn-banner">
              <AlertCircle size={13} />
              <span>No data received for &gt;6 s</span>
            </div>
          )}
          {wsError && !isStale && (
            <div className="warn-banner">
              <AlertCircle size={13} />
              <span>{wsError}</span>
            </div>
          )}

          {/* ── DEMO MODE: User selector ─────────────────────────────────── */}
          {appMode === 'demo' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <SectionTitle icon={<Users size={13} />} label="User Selection" />
                <span style={{ fontSize: 9, color: '#38bdf8', fontFamily: 'JetBrains Mono, monospace' }}>
                  {selectedUser === 'ALL' ? 'ALL 5 USERS' : selectedUser}
                </span>
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 3,
              }}>
                {/* ALL USERS BUTTON */}
                <button
                  id="user-selector-all"
                  onClick={() => setSelectedUser('ALL')}
                  style={{
                    padding: '8px 2px',
                    borderRadius: 8,
                    border: `1.5px solid ${selectedUser === 'ALL' ? '#38bdf8' : 'rgba(56,189,248,0.15)'}`,
                    background: selectedUser === 'ALL' ? 'rgba(56,189,248,0.22)' : 'rgba(8,16,32,0.6)',
                    color: selectedUser === 'ALL' ? '#38bdf8' : '#7fa8c9',
                    cursor: 'pointer',
                    fontSize: 9,
                    fontWeight: 700,
                    fontFamily: 'JetBrains Mono, monospace',
                    transition: 'all 0.2s',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 3,
                  }}
                  title="View all 5 users simultaneously"
                >
                  <Users size={11} style={{ color: selectedUser === 'ALL' ? '#38bdf8' : '#475569' }} />
                  ALL
                </button>

                {/* USER-01 to USER-05 BUTTONS */}
                {USER_IDS.map((uid) => {
                  const color = USER_COLORS[uid] || '#38bdf8';
                  const isSelected = selectedUser === uid;
                  const userState = multiUsers.find((u) => matchUser(u, uid));
                  const isHandover = userState?.towers?.handover_active ?? false;
                  const shortName = uid.replace('USER-', 'U');
                  return (
                    <button
                      key={uid}
                      id={`user-selector-${uid}`}
                      onClick={() => setSelectedUser(uid)}
                      style={{
                        padding: '8px 2px',
                        borderRadius: 8,
                        border: `1.5px solid ${isSelected ? color : 'rgba(56,189,248,0.12)'}`,
                        background: isSelected ? `${color}25` : 'rgba(8,16,32,0.6)',
                        color: isSelected ? color : '#64748b',
                        cursor: 'pointer',
                        fontSize: 9,
                        fontWeight: 700,
                        fontFamily: 'JetBrains Mono, monospace',
                        transition: 'all 0.2s',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 3,
                        position: 'relative',
                      }}
                      title={`Select ${uid}`}
                    >
                      <div style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: color,
                        boxShadow: isHandover ? `0 0 8px ${color}` : `0 0 3px ${color}88`,
                        animation: isHandover ? 'dot-blink 0.6s ease-in-out infinite' : 'none',
                      }} />
                      {shortName}
                    </button>
                  );
                })}
              </div>
              {selectedUserState && (
                <div style={{ marginTop: 8, padding: '5px 8px', borderRadius: 6, background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'JetBrains Mono, monospace' }}>
                    SELECTED: <span style={{ color: USER_COLORS[selectedUser] || '#38bdf8', fontWeight: 700 }}>{selectedUser}</span>
                    {' · '}{selectedUserState.route_name} · {selectedUserState.direction}
                  </span>
                  <button
                    onClick={() => setSelectedUser('ALL')}
                    style={{ background: 'transparent', border: 'none', color: '#38bdf8', fontSize: 9, cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    SHOW ALL ✕
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── LIVE: sub-mode tabs ───────────────────────────────────────── */}
          {appMode === 'live' && (
            <div>
              <SectionTitle icon={<Radio size={13} />} label="Telemetry Source" />
              <div style={{
                display: 'flex', borderRadius: 8,
                background: 'rgba(8,16,32,0.6)', border: '1px solid rgba(56,189,248,0.12)',
                overflow: 'hidden',
              }}>
                {(['desktop', 'mobile'] as const).map((m) => (
                  <button key={m} onClick={() => setLiveSubMode(m)} style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                    padding: '7px 4px', border: 'none', cursor: 'pointer', fontSize: 10,
                    fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.05em',
                    transition: 'all 0.2s',
                    background: liveSubMode === m ? 'rgba(56,189,248,0.15)' : 'transparent',
                    color: liveSubMode === m ? '#38bdf8' : '#475569',
                    borderBottom: liveSubMode === m ? '2px solid #38bdf8' : '2px solid transparent',
                  }}>
                    {m === 'desktop' ? <Monitor size={11} /> : <Smartphone size={11} />}
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── LIVE + Desktop: Simulator controls ──────────────────────── */}
          {appMode === 'live' && liveSubMode === 'desktop' && (
            <div>
              <SectionTitle icon={<Monitor size={13} />} label="Simulator Controls" />
              <div className="metric-card">
                <SimulatorPanel send={send} isConnected={telConnected} />
              </div>
            </div>
          )}

          {/* ── LIVE + Mobile: Info card ─────────────────────────────────── */}
          {appMode === 'live' && liveSubMode === 'mobile' && (
            <div className="metric-card" style={{ textAlign: 'center', padding: '14px' }}>
              <Smartphone size={20} style={{ color: '#38bdf8', margin: '0 auto 6px' }} />
              <p style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0', marginBottom: 6 }}>Open on your phone:</p>
              <code style={{ display: 'block', fontSize: 11, color: '#facc15', background: 'rgba(250,204,21,0.08)', padding: '6px', borderRadius: 6, fontFamily: 'JetBrains Mono, monospace', wordBreak: 'break-all' }}>
                http://localhost:3000/mobile
              </code>
              <p style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>
                Requires HTTPS for deviceorientation on iOS.
              </p>
            </div>
          )}

          {/* ══════════════ DEMO MODE: ALL USERS OVERVIEW ══════════════ */}
          {appMode === 'demo' && selectedUser === 'ALL' && (
            <>
              {/* Fleet Overview */}
              <div>
                <SectionTitle icon={<Activity size={13} />} label="Fleet Network Overview" />
                <div className="metric-card">
                  <MetricRow label="Active Users" value={`${multiUsers.length} / 5 Online`} color="#00ff88" />
                  <MetricRow label="Combined Throughput" value={fleetTotalThroughput.toFixed(0)} unit="Mbps" color="#00ff88" />
                  <MetricRow label="Fleet Avg Latency" value={fleetAvgLatency.toFixed(1)} unit="ms" color="#38bdf8" />
                  <div className="progress-bar" style={{ marginTop: 8 }}>
                    <div className="progress-fill" style={{ width: `${Math.min((fleetTotalThroughput / 5000) * 100, 100)}%` }} />
                  </div>
                </div>
              </div>

              {/* Fleet Handover Efficiency */}
              <div>
                <SectionTitle icon={<TrendingUp size={13} />} label="Fleet Handover Efficiency" />
                <div className="metric-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 10, color: '#475569' }}>Ping-Pong Reduction</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace' }}>
                      {fleetReductionPct}<span style={{ fontSize: 12, color: '#00a855' }}>%</span>
                    </span>
                  </div>
                  <div className="progress-bar" style={{ marginBottom: 10 }}>
                    <div className="progress-fill" style={{ width: `${fleetReductionPct}%`, background: 'linear-gradient(90deg, #00ff88, #38bdf8)' }} />
                  </div>
                  <MetricRow label="Total Fleet Handovers" value={fleetTotalHandovers} color="#e2e8f0" />
                  <MetricRow label="Total Ping-Pong Events" value={fleetPingPongEvents} color="#f59e0b" />
                </div>
              </div>

              {/* Multi-User Fleet Monitor Grid */}
              <div>
                <SectionTitle icon={<Users size={13} />} label="5 Simultaneous Users" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {USER_IDS.map((uid) => {
                    const uState = multiUsers.find((u) => matchUser(u, uid));
                    const color = USER_COLORS[uid] || '#38bdf8';
                    const activeTowerId = uState?.towers?.active_tower?.id ?? null;
                    const isHandover = uState?.towers?.handover_active ?? false;
                    return (
                      <div
                        key={uid}
                        onClick={() => setSelectedUser(uid)}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 8,
                          background: isHandover ? 'rgba(250,204,21,0.08)' : 'rgba(8,16,32,0.7)',
                          border: `1px solid ${isHandover ? 'rgba(250,204,21,0.4)' : 'rgba(56,189,248,0.1)'}`,
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                        }}
                        title={`Click to inspect ${uid}`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 5px ${color}` }} />
                            <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>
                              {uid}
                            </span>
                            <span style={{ fontSize: 9, color: '#64748b', fontFamily: 'JetBrains Mono, monospace' }}>
                              {uState?.direction} · {uState?.route_name}
                            </span>
                          </div>
                          {isHandover ? (
                            <span className="badge badge-amber" style={{ fontSize: 8 }}>
                              HANDOVER
                            </span>
                          ) : (
                            <span className="badge badge-cyan" style={{ fontSize: 8 }}>
                              {activeTowerId ? activeTowerId.replace('TOWER_', 'T-') : 'CONNECTED'}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94a3b8', fontFamily: 'JetBrains Mono, monospace' }}>
                          <span>{uState ? `${uState.vehicle.speed_kmh.toFixed(0)} km/h · ${uState.vehicle.heading.toFixed(0)}°` : '—'}</span>
                          <span>Δ {uState ? uState.prediction.distance_to_center_m.toFixed(1) : '—'} m</span>
                          <span style={{ color: '#00ff88' }}>{uState ? `${uState.network.throughput_mbps.toFixed(0)}M` : '—'}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* ══════════════ SINGLE USER / LIVE TELEMETRY VIEW ══════════════ */}
          {(selectedUser !== 'ALL' || appMode === 'live') && (
            <>
              {/* Handover alert */}
              {handoverActive && activeTower ? (
                <div className="handover-alert" style={{
                  background: 'rgba(250,204,21,0.08)', border: '1px solid rgba(250,204,21,0.45)',
                  padding: '12px 14px', borderRadius: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <AlertTriangle size={14} style={{ color: '#facc15' }} />
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#facc15', letterSpacing: '0.08em', fontFamily: 'JetBrains Mono, monospace' }}>
                      {appMode === 'demo' ? `${selectedUser} · ` : ''}HANDOVER TRIGGERED
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#fde68a', fontWeight: 600, marginBottom: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                    ↪ {activeTower.id} BEAMFORMED_ACTIVE
                  </div>
                  <div style={{ fontSize: 10, color: '#92400e' }}>
                    Confidence:&nbsp;<span style={{ color: '#fcd34d' }}>{((pred?.confidence ?? 0) * 100).toFixed(0)}%</span>
                    &nbsp;·&nbsp;Power:&nbsp;<span style={{ color: '#fcd34d' }}>{activeTower.allocated_power_dbm} dBm</span>
                  </div>
                </div>
              ) : (
                <div className="metric-card" style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#38bdf8', boxShadow: '0 0 6px #38bdf8' }} />
                    <span style={{ fontSize: 10, color: '#38bdf8', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.08em' }}>
                      {appMode === 'demo' ? `${selectedUser} · ` : ''}ALL TOWERS · DEFAULT STATE
                    </span>
                  </div>
                </div>
              )}

              {/* Vehicle Telemetry */}
              <div>
                <SectionTitle
                  icon={<Navigation size={13} />}
                  label={appMode === 'demo' ? `Telemetry — ${selectedUser}` : 'Vehicle Telemetry'}
                />
                <div className="metric-card">
                  <MetricRow label="Speed" value={vehicle?.speed_kmh.toFixed(1) ?? '—'} unit="km/h" color="#facc15" />
                  <MetricRow label="Heading" value={vehicle ? `${vehicle.heading.toFixed(0)}° ${headingLabel(vehicle.heading)}` : '—'} />
                  <MetricRow label="Latitude" value={vehicle?.lat.toFixed(6) ?? '—'} color="#94a3b8" />
                  <MetricRow label="Longitude" value={vehicle?.lon.toFixed(6) ?? '—'} color="#94a3b8" />
                  <MetricRow label="Pred. Path" value={pred?.predicted_path ?? 'NONE'} color={pred?.predicted_path ? '#00ff88' : '#475569'} />
                  <MetricRow label="Confidence" value={pred ? `${(pred.confidence * 100).toFixed(0)}%` : '—'} color="#38bdf8" />
                  {appMode === 'demo' && selectedUserState && (
                    <MetricRow label="Route" value={`${selectedUserState.route_name} (${selectedUserState.direction})`} color="#7fa8c9" />
                  )}
                </div>
              </div>

              {/* Network Metrics */}
              <div>
                <SectionTitle icon={<Activity size={13} />} label="Network Metrics" />
                <div className="metric-card">
                  <MetricRow label="E2E Latency" value={net?.latency_ms.toFixed(1) ?? '—'} unit="ms" color="#38bdf8" />
                  <MetricRow
                    label="H/O Latency"
                    value={net?.handover_latency_ms != null ? net.handover_latency_ms.toFixed(1) : '—'}
                    unit={net?.handover_latency_ms != null ? 'ms' : undefined}
                    color="#f59e0b"
                  />
                  <MetricRow label="Throughput" value={net?.throughput_mbps.toFixed(0) ?? '—'} unit="Mbps" color="#00ff88" />
                  {net && (
                    <div className="progress-bar" style={{ marginTop: 8 }}>
                      <div className="progress-fill" style={{ width: `${Math.min((net.throughput_mbps / 1200) * 100, 100)}%` }} />
                    </div>
                  )}
                </div>
              </div>

              {/* Tower Status */}
              <div>
                <SectionTitle icon={<Signal size={13} />} label="Tower Status" />
                <div className="metric-card" style={{ padding: '8px 12px' }}>
                  {towers.length > 0
                    ? towers.map((t) => <TowerRow key={t.id} tower={t} />)
                    : [0, 1, 2, 3].map((i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, padding: '6px 0' }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#1e293b', flexShrink: 0 }} />
                        <div style={{ flex: 1, height: 10, borderRadius: 4, background: '#0f172a' }} />
                      </div>
                    ))}
                </div>
              </div>

              {/* Efficiency Stats */}
              <div>
                <SectionTitle
                  icon={<TrendingUp size={13} />}
                  label="Efficiency Gains"
                  badge={logCount > 0 && (
                    <span className="log-pill">{logCount} logs</span>
                  )}
                />
                <div className="metric-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <span style={{ fontSize: 10, color: '#475569' }}>Ping-Pong Reduction</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace' }}>
                      {stats?.ping_pong_reduction_pct.toFixed(0) ?? '—'}<span style={{ fontSize: 12, color: '#00a855' }}>%</span>
                    </span>
                  </div>
                  <div className="progress-bar" style={{ marginBottom: 10 }}>
                    <div className="progress-fill" style={{ width: `${stats?.ping_pong_reduction_pct ?? 0}%`, background: 'linear-gradient(90deg, #00ff88, #38bdf8)' }} />
                  </div>
                  <MetricRow label="Total Handovers" value={stats?.total_handovers ?? '—'} />
                  <MetricRow label="Ping-Pong Events" value={stats?.ping_pong_events ?? '—'} color="#f59e0b" />
                </div>
              </div>
            </>
          )}

          {/* ── Steer Controls (all 5 users in demo mode) ─── */}
          {appMode === 'demo' && (
            <div>
              <SectionTitle icon={<Navigation size={13} />} label="Steer Controls" />
              <div className="metric-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {USER_IDS.map((uid) => (
                  <UserSteerControls
                    key={uid}
                    userId={uid}
                    color={USER_COLORS[uid] || '#38bdf8'}
                    sendControl={sendControl}
                    isSelected={selectedUser === uid}
                  />
                ))}
                <div style={{ marginTop: 4, paddingTop: 8, borderTop: '1px solid rgba(56,189,248,0.08)' }}>
                  <button
                    onClick={resetAll}
                    style={{
                      width: '100%', padding: '6px 0', borderRadius: 6,
                      background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                      color: '#ef4444', cursor: 'pointer', fontSize: 10,
                      fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
                      letterSpacing: '0.06em',
                    }}
                  >
                    ↺ RESET ALL USERS
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── System Info ───────────────────────────────────────────────── */}
          <div>
            <SectionTitle icon={<Gauge size={13} />} label="System" />
            <div className="metric-card">
              <MetricRow label="Intersection" value="13.0827, 80.2707" color="#475569" />
              <MetricRow label="H/O Zone" value="50 m radius" color="#f59e0b" />
              <MetricRow label="Alignment Tol." value="±25°" color="#38bdf8" />
              <MetricRow label="Consec. Thresh." value="> 2 ticks" color="#38bdf8" />
              {appMode === 'demo' && (
                <MetricRow label="Active Users" value={`${multiUsers.length} / 5 Simultaneous`} color="#00ff88" />
              )}
            </div>
          </div>

          {/* Footer */}
          <div style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <p style={{ fontSize: 9, color: '#1e3a5f', textAlign: 'center', letterSpacing: '0.08em', fontFamily: 'JetBrains Mono, monospace' }}>
              5G NR · GeoPy · FastAPI · WebSocket · 5 Users
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
