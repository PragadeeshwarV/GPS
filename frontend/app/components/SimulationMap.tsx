'use client';

import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Tooltip, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { SimulationData, Tower, TowerStatus, MultiUserUpdate, MultiUserState } from '../types/simulation';

const TRAIL_MAX = 80;  // keep last N vehicle positions

// Distinct colours for up to 10 simultaneous users
const USER_COLORS = [
  '#facc15', // yellow
  '#f87171', // red
  '#4ade80', // green
  '#a78bfa', // purple
  '#fb923c', // orange
  '#60a5fa', // sky-blue
  '#f472b6', // pink
  '#34d399', // teal
  '#fbbf24', // amber
  '#a3e635', // lime
];

const CENTER_LAT = 13.0827;
const CENTER_LON = 80.2707;

// ── Icon factories ──────────────────────────────────────────────────────────

function createTowerIcon(tower: Tower): L.DivIcon {
  const label = tower.id.replace('TOWER_', '');
  const isBeamformed = tower.status === 'BEAMFORMED_ACTIVE';
  const isConnected = tower.status === 'CONNECTED';
  const isSuppressed = tower.status === 'SUPPRESSED';

  const dotColor = isBeamformed ? '#00ff88' : isConnected ? '#38bdf8' : '#6b7280';
  const ringColor = isBeamformed ? '#00ff88' : '#38bdf8';
  const size = isBeamformed ? 18 : 14;

  const pulseRings = !isSuppressed
    ? `
      <div style="
        position:absolute; top:50%; left:50%;
        transform:translate(-50%,-50%);
        width:${size + 16}px; height:${size + 16}px;
        border-radius:50%;
        border:2px solid ${ringColor};
        opacity:0;
        animation: towerPulse 2s ease-out infinite;
      "></div>
      <div style="
        position:absolute; top:50%; left:50%;
        transform:translate(-50%,-50%);
        width:${size + 30}px; height:${size + 30}px;
        border-radius:50%;
        border:1.5px solid ${ringColor};
        opacity:0;
        animation: towerPulse 2s ease-out 0.7s infinite;
      "></div>`
    : '';

  const xMark = isSuppressed
    ? `<div style="
        position:absolute; top:50%; left:50%;
        transform:translate(-50%,-50%);
        color:#ef4444; font-size:11px; font-weight:900;
        line-height:1; pointer-events:none;">✕</div>`
    : '';

  const beamGlow = isBeamformed
    ? `box-shadow: 0 0 12px 4px rgba(0,255,136,0.5), 0 0 24px 8px rgba(0,255,136,0.2);`
    : '';

  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative; width:60px; height:60px; pointer-events:auto;
        filter: drop-shadow(0 2px 6px rgba(0,0,0,0.85));">
        ${pulseRings}
        <div style="
          position:absolute; top:50%; left:50%;
          transform:translate(-50%,-50%);
          width:${size}px; height:${size}px;
          border-radius:50%;
          background:${dotColor};
          ${beamGlow}
          border: 2px solid rgba(255,255,255,0.35);
          opacity:${isSuppressed ? 0.35 : 1};
          transition: all 0.4s ease;
        ">${xMark}</div>
        <div style="
          position:absolute; bottom:-2px; left:50%;
          transform:translateX(-50%);
          background:rgba(5,10,20,0.88);
          color:${dotColor};
          font-size:9px; font-weight:700;
          font-family:'JetBrains Mono',monospace;
          padding:1px 5px; border-radius:3px;
          border:1px solid ${dotColor}66;
          white-space:nowrap;
          text-shadow: 0 0 6px ${dotColor}99;
          opacity:${isSuppressed ? 0.5 : 1};
        ">${label}</div>
      </div>`,
    iconSize: [60, 60],
    iconAnchor: [30, 30],
  });
}

function createVehicleIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `
      <div style="
        width:28px; height:28px;
        display:flex; align-items:center; justify-content:center;
        transform:rotate(${heading}deg);
        filter: drop-shadow(0 0 6px rgba(250,204,21,0.7));
      ">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
          <circle cx="12" cy="12" r="11" fill="#0a0a1a" stroke="#facc15" stroke-width="1.5"/>
          <path d="M12 5l5 12H7L12 5z" fill="#facc15"/>
        </svg>
      </div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function getUserColor(userId: string, idx: number): string {
  const norm = userId.toUpperCase().replace('_', '-');
  if (norm.includes('01') || norm === 'U1') return '#facc15'; // yellow/amber
  if (norm.includes('02') || norm === 'U2') return '#f87171'; // coral/red
  if (norm.includes('03') || norm === 'U3') return '#4ade80'; // neon green
  if (norm.includes('04') || norm === 'U4') return '#a78bfa'; // purple
  if (norm.includes('05') || norm === 'U5') return '#38bdf8'; // sky cyan
  return USER_COLORS[idx % USER_COLORS.length];
}

function getUserShortLabel(userId: string): string {
  const norm = userId.toUpperCase().replace('_', '-');
  if (norm.startsWith('USER-')) return norm.replace('USER-', 'U');
  if (norm.startsWith('USER')) return norm.replace('USER', 'U');
  return norm.slice(0, 4);
}

function createUserMarkerIcon(heading: number, color: string, label: string, phone: string | undefined, zoom: number, isSelected = false): L.DivIcon {
  const glow = isSelected ? `box-shadow: 0 0 14px 4px ${color}, 0 0 28px 8px ${color}66; border: 2.5px solid #ffffff;` : `border: 2px solid ${color};`;
  
  const displayLabel = zoom > 18 && phone ? `${label} • ${phone}` : label;
  
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative; width:44px; height:44px;">
        <div style="
          position:absolute; top:50%; left:50%;
          transform:translate(-50%,-50%) rotate(${heading}deg);
          width:24px; height:24px;
          display:flex; align-items:center; justify-content:center;
          filter: drop-shadow(0 0 6px ${color}99);
        ">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
            <circle cx="12" cy="12" r="11" fill="#0a0a1a" style="${glow}"/>
            <path d="M12 5l5 12H7L12 5z" fill="${color}"/>
          </svg>
        </div>
        <div style="
          position:absolute; bottom:-2px; left:50%;
          transform:translateX(-50%);
          background:rgba(5,10,20,0.92);
          color:${color};
          font-size:8px; font-weight:700;
          font-family:'JetBrains Mono',monospace;
          padding:1px 4px; border-radius:3px;
          border:1px solid ${isSelected ? color : color + '55'};
          white-space:nowrap;
          text-shadow: 0 0 4px ${color}88;
        ">${displayLabel}</div>
      </div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function createCenterIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `
      <div style="
        width:10px; height:10px;
        border-radius:50%;
        background:#e2e8f0;
        border:2px solid #94a3b8;
        box-shadow: 0 0 8px rgba(255,255,255,0.3);
      "></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
}

// ── Beam line colour per tower status ────────────────────────────────────────

function beamColor(status: TowerStatus): string {
  if (status === 'BEAMFORMED_ACTIVE') return '#00ff88';
  if (status === 'CONNECTED') return '#38bdf8';
  return '#374151';
}

function beamOpacity(status: TowerStatus): number {
  if (status === 'BEAMFORMED_ACTIVE') return 0.75;
  if (status === 'CONNECTED') return 0.25;
  return 0.18;
}

// ── Component ────────────────────────────────────────────────────────────────

interface SimulationMapProps {
  data: SimulationData | null;
  multiData?: MultiUserUpdate | null;
  selectedUser?: string;
}

function ZoomListener({ onZoomChange }: { onZoomChange: (z: number) => void }) {
  useMapEvents({
    zoomend: (e) => onZoomChange(e.target.getZoom()),
  });
  return null;
}

export default function SimulationMap({ data, multiData, selectedUser }: SimulationMapProps) {
  // Keep marker references for live updates
  const towerMarkerRefs  = useRef<Record<string, L.Marker>>({});
  const vehicleMarkerRef = useRef<L.Marker | null>(null);

  // Breadcrumb trail: ring-buffer of [lat, lon] positions (single-user mode)
  const [trail, setTrail] = useState<[number, number][]>([]);

  // Per-user trails for multi-user mode
  const [userTrails, setUserTrails] = useState<Record<string, [number, number][]>>({});

  const [zoomLevel, setZoomLevel] = useState(18);

  const multiUsers: MultiUserState[] = Array.isArray(multiData?.users)
    ? multiData.users
    : Object.values(multiData?.users ?? {});

  // Derive what towers to display
  const activeUser = multiUsers.find((u) => u.user_id === selectedUser);
  const displayTowers: Record<string, Tower> = {};

  const baseTowers = (activeUser?.towers?.all_towers) ??
    (multiData?.towers?.all_towers) ??
    data?.towers?.all_towers ??
    {};

  for (const [tid, tower] of Object.entries(baseTowers)) {
    displayTowers[tid] = { ...tower };
  }

  // If ALL USERS view or no specific user selected, mark towers beamformed by ANY user
  if (!activeUser && multiUsers.length > 0) {
    for (const u of multiUsers) {
      if (u.towers?.active_tower) {
        const atId = u.towers.active_tower.id;
        if (displayTowers[atId]) {
          displayTowers[atId].status = 'BEAMFORMED_ACTIVE';
          displayTowers[atId].allocated_power_dbm = 30.0;
        }
      }
    }
  }

  // Update vehicle icon and trail when position changes (single-user mode)
  useEffect(() => {
    if (!data || !vehicleMarkerRef.current) return;
    vehicleMarkerRef.current.setIcon(createVehicleIcon(data.vehicle.heading));
    vehicleMarkerRef.current.setLatLng([data.vehicle.lat, data.vehicle.lon]);
    setTrail((prev) => {
      const next: [number, number][] = [...prev, [data.vehicle.lat, data.vehicle.lon]];
      return next.length > TRAIL_MAX ? next.slice(next.length - TRAIL_MAX) : next;
    });
  }, [data?.vehicle.lat, data?.vehicle.lon, data?.vehicle.heading]);

  // Update tower icons when status changes (single-user mode)
  useEffect(() => {
    if (!data) return;
    Object.entries(data.towers.all_towers).forEach(([id, tower]) => {
      const ref = towerMarkerRefs.current[id];
      if (ref) ref.setIcon(createTowerIcon(tower));
    });
  }, [data?.towers]);

  // Update per-user trails in multi-user mode
  useEffect(() => {
    if (multiUsers.length === 0) return;
    setUserTrails((prev) => {
      const next: Record<string, [number, number][]> = {};
      for (const user of multiUsers) {
        const existing = prev[user.user_id] ?? [];
        const lastPt = existing[existing.length - 1];
        const newPt: [number, number] = [user.vehicle.lat, user.vehicle.lon];
        const changed = !lastPt || lastPt[0] !== newPt[0] || lastPt[1] !== newPt[1];
        const updated = changed ? [...existing, newPt] : existing;
        next[user.user_id] = updated.length > TRAIL_MAX
          ? updated.slice(updated.length - TRAIL_MAX)
          : updated;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiData]);

  return (
    <MapContainer
      center={[CENTER_LAT, CENTER_LON]}
      zoom={18}
      style={{ width: '100%', height: '100%', background: '#0c1220' }}
      zoomControl={false}
    >
      <ZoomListener onZoomChange={setZoomLevel} />
      {/* Satellite base layer */}
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        attribution='Imagery &copy; Esri'
        maxZoom={19}
        zIndex={1}
      />
      {/* Road labels overlay — translucent so satellite shows through */}
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png"
        attribution='Labels &copy; <a href="https://carto.com">CARTO</a>'
        maxZoom={19}
        opacity={0.82}
        zIndex={2}
      />

      {/* Vehicle breadcrumb trail (single-user mode) */}
      {trail.length > 1 && (
        <Polyline
          positions={trail}
          color="#facc15"
          weight={2.5}
          opacity={0.55}
          dashArray="4 5"
        />
      )}

      {/* Intersection centre */}
      <Marker position={[CENTER_LAT, CENTER_LON]} icon={createCenterIcon()}>
        <Tooltip permanent direction="top" offset={[0, -8]} className="hud-tooltip">
          <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
            ⊕ Intersection
          </span>
        </Tooltip>
      </Marker>

      {/* Beamforming lines: centre → each tower */}
      {Object.values(displayTowers).map((tower) => (
        <Polyline
          key={`beam-${tower.id}`}
          positions={[
            [CENTER_LAT, CENTER_LON],
            [tower.coordinates.lat, tower.coordinates.lon],
          ]}
          color={beamColor(tower.status)}
          weight={tower.status === 'BEAMFORMED_ACTIVE' ? 3 : tower.status === 'CONNECTED' ? 1.5 : 1}
          opacity={beamOpacity(tower.status)}
          dashArray={tower.status === 'BEAMFORMED_ACTIVE' ? undefined : '6 4'}
        />
      ))}

      {/* Tower markers */}
      {Object.values(displayTowers).map((tower) => (
        <Marker
          key={tower.id}
          position={[tower.coordinates.lat, tower.coordinates.lon]}
          icon={createTowerIcon(tower)}
          ref={(ref) => {
            if (ref) towerMarkerRefs.current[tower.id] = ref;
          }}
        >
          <Tooltip direction="right" offset={[16, 0]} opacity={0.95}>
            <div style={{ fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6, color: '#e2e8f0' }}>
              <div style={{ fontWeight: 700, color: tower.status === 'BEAMFORMED_ACTIVE' ? '#00ff88' : '#38bdf8' }}>
                {tower.name}
              </div>
              <div>Band: {tower.frequency_band}</div>
              <div>Status: <b>{tower.status}</b></div>
              <div>Power: {tower.allocated_power_dbm} dBm</div>
            </div>
          </Tooltip>
        </Marker>
      ))}

      {/* Coverage radius circles */}
      {Object.values(displayTowers).map((tower) => (
        <CircleMarker
          key={`radius-${tower.id}`}
          center={[tower.coordinates.lat, tower.coordinates.lon]}
          radius={tower.status === 'BEAMFORMED_ACTIVE' ? 38 : 22}
          pathOptions={{
            color: beamColor(tower.status),
            fillColor: beamColor(tower.status),
            fillOpacity: tower.status === 'BEAMFORMED_ACTIVE' ? 0.06 : 0.02,
            opacity: tower.status === 'BEAMFORMED_ACTIVE' ? 0.45 : 0.12,
            weight: 1,
          }}
        />
      ))}

      {/* Single-user vehicle marker (demo / live mode — only when no multiData) */}
      {data && !multiData && (
        <Marker
          position={[data.vehicle.lat, data.vehicle.lon]}
          icon={createVehicleIcon(data.vehicle.heading)}
          ref={(ref) => {
            vehicleMarkerRef.current = ref;
          }}
        >
          <Tooltip direction="right" offset={[14, 0]} opacity={0.9}>
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#facc15' }}>
              🚗 {data.vehicle.speed_kmh} km/h • {data.vehicle.heading}°
            </span>
          </Tooltip>
        </Marker>
      )}

      {/* Multi-user vehicle markers — ALL five always visible */}
      {multiUsers.map((user, idx) => {
        const color = getUserColor(user.user_id, idx);
        const shortId = getUserShortLabel(user.user_id);
        const isSelected = selectedUser === user.user_id;
        const userTrail = userTrails[user.user_id];
        const activeTower = user.towers?.active_tower ?? null;
        const activeTowerId = activeTower?.id ?? null;
        const totalHandovers = user.towers?.stats?.total_handovers ?? 0;
        return (
          <React.Fragment key={user.user_id}>
            {/* Per-user breadcrumb trail */}
            {userTrail && userTrail.length > 1 && (
              <Polyline
                positions={userTrail}
                color={color}
                weight={isSelected ? 3 : 2}
                opacity={isSelected ? 0.75 : 0.45}
                dashArray="4 5"
              />
            )}
            {/* Direct 5G beamforming line from user to their active tower */}
            {activeTower && activeTower.coordinates && (
              <Polyline
                positions={[
                  [user.vehicle.lat, user.vehicle.lon],
                  [activeTower.coordinates.lat, activeTower.coordinates.lon],
                ]}
                color={color}
                weight={isSelected ? 3.5 : 2.5}
                opacity={0.8}
              />
            )}
            {/* Per-user vehicle marker */}
            <Marker
              position={[user.vehicle.lat, user.vehicle.lon]}
              icon={createUserMarkerIcon(user.vehicle.heading, color, shortId, user.phone_number, zoomLevel, isSelected)}
            >
              <Tooltip direction="right" offset={[22, 0]} opacity={0.95}>
                <div style={{ fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6, color: '#e2e8f0' }}>
                  <div style={{ fontWeight: 700, color }}>{user.user_id.toUpperCase()}</div>
                  {user.phone_number && <div style={{ color: '#a1a1aa' }}>Tel: {user.phone_number}</div>}
                  <div>Dir: {user.direction} · {user.route_name}</div>
                  <div>Speed: {user.vehicle.speed_kmh} km/h · {user.vehicle.heading}°</div>
                  <div>Status: {user.running ? '▶ MOVING' : '⏸ STOPPED'}</div>
                  {activeTowerId && (
                    <div style={{ color: '#00ff88', fontWeight: 700 }}>Tower: {activeTowerId} (ACTIVE)</div>
                  )}
                  {user.prediction.predicted_path && (
                    <div>Pred: {user.prediction.predicted_path} ({(user.prediction.confidence * 100).toFixed(0)}%)</div>
                  )}
                  <div>Handovers: {totalHandovers} · Ping-Pong: {user.towers?.stats?.ping_pong_events ?? 0}</div>
                  <div>Latency: {user.network?.latency_ms?.toFixed(1) ?? '—'} ms · {user.network?.throughput_mbps?.toFixed(0) ?? '—'} Mbps</div>
                </div>
              </Tooltip>
            </Marker>
          </React.Fragment>
        );
      })}

      {/* 50m handover zone */}
      <CircleMarker
        center={[CENTER_LAT, CENTER_LON]}
        radius={40}
        pathOptions={{
          color: '#f59e0b',
          fillColor: '#f59e0b',
          fillOpacity: 0.04,
          opacity: 0.3,
          weight: 1,
          dashArray: '5 4',
        }}
      />
    </MapContainer>
  );
}
