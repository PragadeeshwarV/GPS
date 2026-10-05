'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { SimulationData } from '../types/simulation';

const WS_URL = 'ws://localhost:8000/ws/telemetry';
const RECONNECT_DELAY_MS = 2500;

export interface TelemetryPayload {
  lat: number;
  lon: number;
  heading: number;
  speed: number;
  source?: 'desktop' | 'mobile';
  user_id?: string;
}

interface UseTelemetryReturn {
  data: SimulationData | null;
  isConnected: boolean;
  error: string | null;
  send: (payload: TelemetryPayload) => void;
}

export function useTelemetry(): UseTelemetryReturn {
  const [data, setData] = useState<SimulationData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);

  const connect = useCallback(() => {
    if (!isMounted.current) return;
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted.current) return;
        setIsConnected(true);
        setError(null);
        ws.send('ping');
      };

      ws.onmessage = (event) => {
        if (!isMounted.current) return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'reset_ack') return;
          setData(parsed as SimulationData);
        } catch { /* ignore */ }
      };

      ws.onerror = () => {
        if (!isMounted.current) return;
        setError('Telemetry WebSocket error — retrying…');
      };

      ws.onclose = () => {
        if (!isMounted.current) return;
        setIsConnected(false);
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    } catch (err) {
      setError(`Failed to connect: ${err}`);
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  }, []);

  const send = useCallback((payload: TelemetryPayload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    connect();
    return () => {
      isMounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { data, isConnected, error, send };
}
