'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MultiUserUpdate } from '../types/simulation';

const WS_URL = 'ws://localhost:8000/ws/multi';
const API_BASE = 'http://localhost:8000';
const RECONNECT_DELAY_MS = 2500;

export interface UseMultiSimulationReturn {
  data: MultiUserUpdate | null;
  isConnected: boolean;
  error: string | null;
  /** Send a directional control command to one specific user */
  sendControl: (userId: string, action: 'left' | 'right') => void;
  /** Reset all five users to fresh state */
  resetAll: () => Promise<void>;
}

export function useMultiSimulation(): UseMultiSimulationReturn {
  const [data, setData] = useState<MultiUserUpdate | null>(null);
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
      };

      ws.onmessage = (event) => {
        if (!isMounted.current) return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'multi_update') {
            if (parsed.users && !Array.isArray(parsed.users)) {
              parsed.users = Object.values(parsed.users);
            }
            setData(parsed as MultiUserUpdate);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        if (!isMounted.current) return;
        setError('Multi-user WebSocket error — retrying…');
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

  useEffect(() => {
    isMounted.current = true;
    connect();
    return () => {
      isMounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // ── Send a LEFT/RIGHT control to a specific user ─────────────────────────

  const sendControl = useCallback((userId: string, action: 'left' | 'right') => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'control',
      user_id: userId,
      action,
    }));
  }, []);

  // ── Reset all users via REST ──────────────────────────────────────────────

  const resetAll = useCallback(async () => {
    await fetch(`${API_BASE}/api/multi/reset`, { method: 'POST' });
  }, []);

  return { data, isConnected, error, sendControl, resetAll };
}
