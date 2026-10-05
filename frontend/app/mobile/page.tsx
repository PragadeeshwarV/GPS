'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Wifi, WifiOff, MapPin, Compass, Zap, Activity, AlertTriangle, ShieldAlert, Lock } from 'lucide-react';

const WS_URL = 'ws://localhost:8000/ws/telemetry';
const RECONNECT_DELAY_MS = 3000;

// ── Types ────────────────────────────────────────────────────────────────────

type GpsPermission = 'unknown' | 'granted' | 'denied' | 'prompt' | 'unavailable' | 'timeout';

interface GeoState {
  lat: number | null;
  lon: number | null;
  speed_kmh: number | null;
  accuracy: number | null;
  error: string | null;
  permissionState: GpsPermission;
}

interface OrientationState {
  heading: number | null;
  available: boolean;
}

interface PredictionResult {
  predicted_path: string | null;
  confidence: number;
  distance_to_center_m: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(val: number | null, decimals = 2): string {
  return val != null ? val.toFixed(decimals) : '—';
}

function compassLabel(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

function isHttps(): boolean {
  if (typeof window === 'undefined') return true;
  return window.location.protocol === 'https:' || window.location.hostname === 'localhost';
}

function getGpsErrorMessage(err: GeolocationPositionError, perm: GpsPermission): string {
  switch (err.code) {
    case GeolocationPositionError.PERMISSION_DENIED:
      return 'GPS permission denied. Please allow location access in your browser settings and refresh the page.';
    case GeolocationPositionError.POSITION_UNAVAILABLE:
      return 'GPS signal unavailable. Ensure you are in an open area with GPS enabled.';
    case GeolocationPositionError.TIMEOUT:
      return 'GPS acquisition timed out. Check that location services are enabled on your device.';
    default:
      return `GPS error: ${err.message}`;
  }
}

function getPermissionCode(err: GeolocationPositionError): GpsPermission {
  switch (err.code) {
    case GeolocationPositionError.PERMISSION_DENIED: return 'denied';
    case GeolocationPositionError.POSITION_UNAVAILABLE: return 'unavailable';
    case GeolocationPositionError.TIMEOUT: return 'timeout';
    default: return 'unknown';
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MobilePage() {
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [geo, setGeo] = useState<GeoState>({
    lat: null, lon: null, speed_kmh: null, accuracy: null,
    error: null, permissionState: 'unknown',
  });
  const [orientation, setOrientation] = useState<OrientationState>({ heading: null, available: false });
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [tickCount, setTickCount] = useState(0);
  const [mobileUserId, setMobileUserId] = useState<string>('USER-01');
  const [wsError, setWsError] = useState<string | null>(null);
  const [httpsWarning] = useState(!isHttps());

  const wsRef = useRef<WebSocket | null>(null);
  const geoWatchRef = useRef<number | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);

  // ── WebSocket ──────────────────────────────────────────────────────────────

  const connectWs = useCallback(() => {
    if (!isMounted.current) return;
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted.current) return;
        setWsConnected(true);
        setWsError(null);
        ws.send('ping');
      };

      ws.onmessage = (ev) => {
        if (!isMounted.current) return;
        try {
          const data = JSON.parse(ev.data);
          if (data?.prediction) {
            setPrediction(data.prediction);
          }
          setTickCount((t) => t + 1);
        } catch { /* ignore */ }
      };

      ws.onerror = () => {
        if (!isMounted.current) return;
        setWsError('WebSocket connection failed. Ensure the backend server is running on port 8000.');
      };

      ws.onclose = (event) => {
        if (!isMounted.current) return;
        setWsConnected(false);
        if (event.code !== 1000) {
          // Abnormal closure — schedule reconnect
          if (isTransmitting) {
            reconnectRef.current = setTimeout(connectWs, RECONNECT_DELAY_MS);
          }
        }
      };
    } catch (err) {
      setWsError(`WebSocket failed to initialise: ${err}`);
    }
  }, [isTransmitting]);

  // ── Device Orientation ────────────────────────────────────────────────────

  const handleOrientation = useCallback((ev: DeviceOrientationEvent) => {
    let heading: number | null = null;

    // iOS: webkitCompassHeading (clockwise from true north)
    if ((ev as any).webkitCompassHeading != null) {
      heading = (ev as any).webkitCompassHeading;
    }
    // Android with absolute orientation
    else if ((ev as any).absolute && ev.alpha != null) {
      heading = (360 - ev.alpha) % 360;
    }
    // Fallback: alpha (less accurate)
    else if (ev.alpha != null) {
      heading = (360 - ev.alpha) % 360;
    }

    setOrientation({ heading, available: heading != null });
  }, []);

  // ── Geolocation ───────────────────────────────────────────────────────────

  const checkPermission = useCallback(async (): Promise<GpsPermission> => {
    if (!('geolocation' in navigator)) return 'unavailable';
    if ('permissions' in navigator) {
      try {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        return result.state as GpsPermission;
      } catch {
        return 'unknown';
      }
    }
    return 'unknown';
  }, []);

  const startGeo = useCallback(async () => {
    if (!('geolocation' in navigator)) {
      setGeo((g) => ({
        ...g,
        error: 'Geolocation is not supported by this browser.',
        permissionState: 'unavailable',
      }));
      return;
    }

    // Check current permission state
    const perm = await checkPermission();
    if (perm === 'denied') {
      setGeo((g) => ({
        ...g,
        error: 'GPS permission is blocked. Open browser settings → Site Permissions → Location and allow this site.',
        permissionState: 'denied',
      }));
      return;
    }

    setGeo((g) => ({ ...g, permissionState: perm, error: null }));

    geoWatchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed, accuracy } = pos.coords;
        const speed_kmh = speed != null ? +(speed * 3.6).toFixed(1) : null;

        setGeo({
          lat: latitude,
          lon: longitude,
          speed_kmh,
          accuracy,
          error: null,
          permissionState: 'granted',
        });

        // Send telemetry if WS is ready
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const heading = orientation.heading ?? 0;
          wsRef.current.send(JSON.stringify({
            lat: latitude,
            lon: longitude,
            heading: Math.round(heading),
            speed: speed_kmh ?? 0,
            source: 'mobile',
            user_id: mobileUserId,
          }));
        }
      },
      (err) => {
        const permCode = getPermissionCode(err);
        const msg = getGpsErrorMessage(err, permCode);
        setGeo((g) => ({ ...g, error: msg, permissionState: permCode }));
        // If permission denied, no point retrying watchPosition
        if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
          if (geoWatchRef.current != null) {
            navigator.geolocation.clearWatch(geoWatchRef.current);
            geoWatchRef.current = null;
          }
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 500 }
    );
  }, [orientation.heading, checkPermission, mobileUserId]);

  const stopGeo = useCallback(() => {
    if (geoWatchRef.current != null) {
      navigator.geolocation.clearWatch(geoWatchRef.current);
      geoWatchRef.current = null;
    }
  }, []);

  // ── Request iOS compass permission ─────────────────────────────────────────

  const requestOrientationPermission = useCallback(async () => {
    const DOE = (DeviceOrientationEvent as any);
    if (typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission();
        if (result !== 'granted') return;
      } catch { return; }
    }

    // Try absolute first (Android Chrome)
    window.addEventListener('deviceorientationabsolute', handleOrientation as any, true);
    window.addEventListener('deviceorientation', handleOrientation as any, true);
  }, [handleOrientation]);

  // ── Start / Stop ──────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    setIsTransmitting(true);
    setTickCount(0);
    setPrediction(null);
    setWsError(null);
    connectWs();
    await requestOrientationPermission();
    await startGeo();
  }, [connectWs, requestOrientationPermission, startGeo]);

  const handleStop = useCallback(() => {
    setIsTransmitting(false);
    stopGeo();
    wsRef.current?.close(1000, 'User stopped');
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
    setWsConnected(false);
    setGeo((g) => ({ ...g, permissionState: 'unknown' }));
  }, [stopGeo]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      stopGeo();
      wsRef.current?.close(1000, 'Component unmounted');
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      window.removeEventListener('deviceorientationabsolute', handleOrientation as any, true);
      window.removeEventListener('deviceorientation', handleOrientation as any, true);
    };
  }, [handleOrientation, stopGeo]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const hasGps = geo.lat != null;
  const predPath = prediction?.predicted_path;
  const predColor = predPath ? '#00ff88' : '#38bdf8';
  const gpsBlocked = geo.permissionState === 'denied' || geo.permissionState === 'unavailable';

  return (
    <div style={{
      minHeight: '100dvh', background: '#05090f',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'Inter, sans-serif', color: '#e2e8f0',
      padding: '0 0 env(safe-area-inset-bottom)',
    }}>

      {/* Status bar */}
      <div style={{
        padding: '12px 20px 8px',
        background: 'rgba(8,16,32,0.9)',
        borderBottom: '1px solid rgba(56,189,248,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: wsConnected ? '#00ff88' : '#ef4444',
            boxShadow: wsConnected ? '0 0 8px #00ff88' : 'none',
            animation: wsConnected ? 'dot-blink 1.2s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontSize: 11, color: wsConnected ? '#00ff88' : '#ef4444', fontFamily: 'JetBrains Mono, monospace' }}>
            {wsConnected ? 'CONNECTED' : isTransmitting ? 'CONNECTING…' : 'OFFLINE'}
          </span>
        </div>
        <span style={{ fontSize: 10, color: '#3d5a78', fontFamily: 'JetBrains Mono, monospace' }}>
          5G HANDOVER · MOBILE STREAMER
        </span>
      </div>

      {/* HTTPS warning */}
      {httpsWarning && (
        <div style={{
          margin: '12px 16px 0',
          padding: '10px 14px', borderRadius: 10,
          background: 'rgba(245,158,11,0.1)',
          border: '1px solid rgba(245,158,11,0.4)',
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <Lock size={14} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24', marginBottom: 3, fontFamily: 'JetBrains Mono, monospace' }}>
              HTTPS REQUIRED
            </div>
            <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
              Device orientation (compass) requires HTTPS on iOS. GPS works on localhost only.
              For real device testing, deploy behind HTTPS.
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px', gap: 24 }}>

        {/* Device User ID selection */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.08em' }}>
            TRANSMITTING AS VEHICLE:
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {['USER-01', 'USER-02', 'USER-03', 'USER-04', 'USER-05'].map((uid) => (
              <button
                key={uid}
                onClick={() => setMobileUserId(uid)}
                disabled={isTransmitting}
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: mobileUserId === uid ? '1px solid #00ff88' : '1px solid rgba(255,255,255,0.1)',
                  background: mobileUserId === uid ? 'rgba(0,255,136,0.15)' : 'rgba(15,23,42,0.6)',
                  color: mobileUserId === uid ? '#00ff88' : '#64748b',
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: 'JetBrains Mono, monospace',
                  cursor: isTransmitting ? 'not-allowed' : 'pointer',
                  opacity: isTransmitting && mobileUserId !== uid ? 0.4 : 1,
                }}
              >
                {uid}
              </button>
            ))}
          </div>
        </div>

        {/* Big CTA button */}
        <div style={{ textAlign: 'center' }}>
          <button
            id="mobile-transmit-btn"
            onClick={isTransmitting ? handleStop : handleStart}
            style={{
              width: 180, height: 180, borderRadius: '50%', border: 'none',
              cursor: 'pointer', outline: 'none',
              background: isTransmitting
                ? 'radial-gradient(circle, rgba(239,68,68,0.25), rgba(185,28,28,0.1))'
                : 'radial-gradient(circle, rgba(0,255,136,0.25), rgba(0,180,100,0.1))',
              boxShadow: isTransmitting
                ? '0 0 0 3px rgba(239,68,68,0.4), 0 0 60px rgba(239,68,68,0.2)'
                : '0 0 0 3px rgba(0,255,136,0.4), 0 0 60px rgba(0,255,136,0.2)',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 12,
              transition: 'all 0.35s ease',
              transform: isTransmitting ? 'scale(1.02)' : 'scale(1)',
            }}
          >
            {isTransmitting ? (
              <>
                <WifiOff size={44} style={{ color: '#ef4444' }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: '#ef4444', letterSpacing: '0.08em', fontFamily: 'JetBrains Mono, monospace' }}>
                  STOP
                </span>
              </>
            ) : (
              <>
                <Wifi size={44} style={{ color: '#00ff88' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: '#00ff88', letterSpacing: '0.05em', fontFamily: 'JetBrains Mono, monospace', textAlign: 'center', lineHeight: 1.3 }}>
                  START<br />TRANSMITTING
                </span>
              </>
            )}
          </button>

          {isTransmitting && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#00ff88', animation: 'dot-blink 1s ease-in-out infinite' }} />
              <span style={{ fontSize: 11, color: '#00ff88', fontFamily: 'JetBrains Mono, monospace' }}>
                {tickCount} packets sent
              </span>
            </div>
          )}
        </div>

        {/* GPS + Orientation readouts */}
        {isTransmitting && (
          <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* GPS permission blocked banner */}
            {gpsBlocked && (
              <div style={{
                padding: '12px 16px', borderRadius: 12,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.35)',
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <ShieldAlert size={16} style={{ color: '#ef4444', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', marginBottom: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                    {geo.permissionState === 'denied' ? 'LOCATION ACCESS DENIED' : 'GPS UNAVAILABLE'}
                  </div>
                  <div style={{ fontSize: 11, color: '#fca5a5', lineHeight: 1.5 }}>
                    {geo.permissionState === 'denied'
                      ? 'Open browser → Settings → Site Permissions → Location and enable access for this site.'
                      : 'GPS hardware is unavailable on this device. Move to an open area or check device settings.'}
                  </div>
                </div>
              </div>
            )}

            {/* GPS card */}
            <div style={{
              background: 'rgba(8,16,32,0.8)', borderRadius: 14,
              border: `1px solid ${gpsBlocked ? 'rgba(239,68,68,0.25)' : hasGps ? 'rgba(0,255,136,0.25)' : 'rgba(56,189,248,0.15)'}`,
              padding: '14px 18px',
              transition: 'border-color 0.3s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <MapPin size={14} style={{ color: gpsBlocked ? '#ef4444' : hasGps ? '#00ff88' : '#475569' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: '#7fa8c9', letterSpacing: '0.08em', fontFamily: 'JetBrains Mono, monospace' }}>
                  GPS
                </span>
                {hasGps && geo.accuracy != null && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>
                    ±{geo.accuracy.toFixed(0)} m
                  </span>
                )}
                {gpsBlocked && (
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: '#ef4444', fontFamily: 'JetBrains Mono, monospace', background: 'rgba(239,68,68,0.1)', padding: '2px 6px', borderRadius: 4 }}>
                    BLOCKED
                  </span>
                )}
                {!gpsBlocked && !hasGps && isTransmitting && (
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: '#f59e0b', fontFamily: 'JetBrains Mono, monospace', background: 'rgba(245,158,11,0.1)', padding: '2px 6px', borderRadius: 4 }}>
                    ACQUIRING
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                <DataItem label="Latitude" value={fmt(geo.lat, 6)} />
                <DataItem label="Longitude" value={fmt(geo.lon, 6)} />
                <DataItem label="Speed" value={geo.speed_kmh != null ? `${geo.speed_kmh} km/h` : '—'} highlight />
                <DataItem
                  label="GPS Status"
                  value={gpsBlocked ? geo.permissionState.toUpperCase() : hasGps ? 'LOCKED' : 'ACQUIRING'}
                  highlight={hasGps && !gpsBlocked}
                  error={gpsBlocked}
                />
              </div>
              {geo.error && !gpsBlocked && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#f59e0b', lineHeight: 1.4 }}>
                  <AlertTriangle size={11} style={{ display: 'inline', marginRight: 4 }} />
                  {geo.error}
                </div>
              )}
            </div>

            {/* Compass card */}
            <div style={{
              background: 'rgba(8,16,32,0.8)', borderRadius: 14,
              border: `1px solid ${orientation.available ? 'rgba(56,189,248,0.25)' : 'rgba(56,189,248,0.1)'}`,
              padding: '14px 18px',
              transition: 'border-color 0.3s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <Compass size={14} style={{ color: orientation.available ? '#38bdf8' : '#475569' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: '#7fa8c9', letterSpacing: '0.08em', fontFamily: 'JetBrains Mono, monospace' }}>
                  COMPASS
                </span>
              </div>
              {orientation.available && orientation.heading != null ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  {/* Visual compass dial */}
                  <div style={{
                    width: 64, height: 64, borderRadius: '50%', flexShrink: 0,
                    border: '2px solid rgba(56,189,248,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    position: 'relative', background: 'rgba(56,189,248,0.04)',
                  }}>
                    <div style={{
                      width: 4, height: 28, borderRadius: 2,
                      background: 'linear-gradient(to bottom, #ef4444 50%, #475569 50%)',
                      transform: `rotate(${orientation.heading}deg)`,
                      transformOrigin: '50% 75%',
                      transition: 'transform 0.2s ease',
                    }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#e2e8f0', fontFamily: 'JetBrains Mono, monospace', lineHeight: 1 }}>
                      {Math.round(orientation.heading)}°
                    </div>
                    <div style={{ fontSize: 14, color: '#38bdf8', marginTop: 2 }}>
                      {compassLabel(orientation.heading)}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#475569' }}>
                  {!orientation.available ? 'Compass not available on this device' : 'Calibrating…'}
                </div>
              )}
            </div>

            {/* Prediction card */}
            {prediction && (
              <div style={{
                background: predPath ? 'rgba(0,255,136,0.06)' : 'rgba(8,16,32,0.8)',
                borderRadius: 14,
                border: `1px solid ${predPath ? 'rgba(0,255,136,0.35)' : 'rgba(56,189,248,0.15)'}`,
                padding: '14px 18px',
                transition: 'all 0.4s ease',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Activity size={14} style={{ color: predColor }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#7fa8c9', letterSpacing: '0.08em', fontFamily: 'JetBrains Mono, monospace' }}>
                    PREDICTION
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                  <DataItem label="Path" value={predPath ?? 'NONE'} highlight={!!predPath} />
                  <DataItem label="Confidence" value={`${(prediction.confidence * 100).toFixed(0)}%`} highlight={prediction.confidence > 0.5} />
                  <DataItem label="Distance" value={`${prediction.distance_to_center_m.toFixed(1)} m`} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Not transmitting: prompt */}
        {!isTransmitting && (
          <div style={{ textAlign: 'center', maxWidth: 280 }}>
            <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.7 }}>
              Tap <strong style={{ color: '#00ff88' }}>START TRANSMITTING</strong> to stream your GPS location and compass heading to the 5G handover prediction engine.
            </p>
            <p style={{ fontSize: 11, color: '#3d5a78', marginTop: 12 }}>
              Walk towards the intersection at 13.0827°N, 80.2707°E
            </p>
            <div style={{ marginTop: 16, padding: '10px 14px', borderRadius: 10, background: 'rgba(56,189,248,0.05)', border: '1px solid rgba(56,189,248,0.15)' }}>
              <p style={{ fontSize: 10, color: '#3d5a78', fontFamily: 'JetBrains Mono, monospace', lineHeight: 1.6 }}>
                ℹ️ Grant <strong style={{ color: '#38bdf8' }}>Location</strong> permission when prompted.<br />
                Compass requires <strong style={{ color: '#38bdf8' }}>HTTPS</strong> on iOS devices.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* WS Error banner */}
      {wsError && (
        <div style={{ margin: '0 16px 16px', padding: '10px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <AlertTriangle size={14} style={{ color: '#ef4444', flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 11, color: '#ef4444', lineHeight: 1.5 }}>{wsError}</span>
        </div>
      )}

      {/* Bottom padding for safe area */}
      <div style={{ height: 'env(safe-area-inset-bottom, 16px)' }} />
    </div>
  );
}

function DataItem({ label, value, highlight, error }: { label: string; value: string; highlight?: boolean; error?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: '#3d5a78', marginBottom: 2, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.06em' }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: error ? '#ef4444' : highlight ? '#e2e8f0' : '#94a3b8' }}>
        {value}
      </div>
    </div>
  );
}
