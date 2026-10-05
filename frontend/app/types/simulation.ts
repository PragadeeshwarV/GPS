// Shared TypeScript interfaces for the simulation WebSocket stream

export type TowerStatus = 'CONNECTED' | 'IDLE' | 'SUPPRESSED' | 'BEAMFORMED_ACTIVE';

export interface Tower {
  id: string;
  name: string;
  path: string;
  coordinates: { lat: number; lon: number };
  frequency_band: string;
  status: TowerStatus;
  allocated_power_dbm: number;
}

export interface SimulationData {
  tick: number;
  timestamp: string;
  vehicle: {
    lat: number;
    lon: number;
    heading: number;
    speed_kmh: number;
  };
  prediction: {
    predicted_path: string | null;
    confidence: number;
    distance_to_center_m: number;
  };
  towers: {
    handover_active: boolean;
    active_tower: Tower | null;
    suppressed_towers: Tower[];
    all_towers: Record<string, Tower>;
    stats: {
      total_handovers: number;
      ping_pong_events: number;
      ping_pong_reduction_pct: number;
    };
  };
  network: {
    latency_ms: number;
    handover_latency_ms: number | null;
    throughput_mbps: number;
  };
}

// ── Multi-user types ──────────────────────────────────────────────────────────

export interface MultiUserHandoverLogEntry {
  user_id: string;
  timestamp: string;
  tick: number;
  event: 'HANDOVER' | 'CLEAR';
  tower_id: string | null;
  confidence: number;
  lat: number;
  lon: number;
  heading: number;
  speed_kmh: number;
  predicted_path: string | null;
  distance_m: number;
  latency_ms: number;
  throughput_mbps: number;
}

/** Per-user tower snapshot — mirrors TowerController.get_state_snapshot() */
export interface UserTowerSnapshot {
  handover_active: boolean;
  active_tower: Tower | null;
  suppressed_towers: Tower[];
  all_towers: Record<string, Tower>;
  stats: {
    total_handovers: number;
    ping_pong_events: number;
    ping_pong_reduction_pct: number;
  };
}

export interface MultiUserState {
  user_id: string;
  phone_number?: string;
  route_name: string;
  direction: string;
  running: boolean;
  tick: number;
  vehicle: {
    lat: number;
    lon: number;
    heading: number;
    speed_kmh: number;
  };
  prediction: {
    predicted_path: string | null;
    confidence: number;
    distance_to_center_m: number;
  };
  /** Full independent tower snapshot for this user */
  towers: UserTowerSnapshot;
  network: {
    latency_ms: number;
    handover_latency_ms: number | null;
    throughput_mbps: number;
  };
  handover_log: MultiUserHandoverLogEntry[];
}

export type UserId = 'USER-01' | 'USER-02' | 'USER-03' | 'USER-04' | 'USER-05' | string;
export type UserSelection = 'ALL' | 'USER-01' | 'USER-02' | 'USER-03' | 'USER-04' | 'USER-05';

export interface MultiUserUpdate {
  type: 'multi_update';
  tick?: number;
  timestamp: string;
  source?: string;
  towers: {
    all_towers: Record<string, Tower>;
  };
  users: MultiUserState[];
  users_map?: Record<string, MultiUserState>;
}

// ── Multi-user log entry for client-side logging ─────────────────────────────

export interface MultiLogEntry {
  user_id: string;
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
