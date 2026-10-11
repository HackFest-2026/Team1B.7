"use client";

import { useEffect, useRef } from "react";
import { SENTINEL_STREAM_URL, type ReplayState, type SentinelStatus } from "./api";

/** Payload of an `alert` event (new WATCH or CONFIRMED GO). Replay alerts carry `replay: true`. */
export interface AlertEvent {
  dedupe: string;
  replay?: boolean;
  alert: {
    status: string;
    primary_name: string;
    secondary_name: string;
    pc: number;
    miss_km: number;
    hours_to_tca: number;
    decision: string;
    id?: string;
  };
}

export interface StreamHandlers {
  onAlert?: (e: AlertEvent) => void;
  onRun?: (phase: "started" | "finished", status?: SentinelStatus) => void;
  onReplay?: (s: ReplayState) => void;
  onHello?: (status: SentinelStatus) => void;
  /** More notifications than the per-cycle cap: one summary instead of many toasts. */
  onSummary?: (e: { dedupe: string; count: number; text: string }) => void;
}

const SEEN_KEY = "kw.sentinel.notified";

function seenSet(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function remember(s: Set<string>) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-300)));
  } catch {
    /* storage unavailable: dedupe for this page only */
  }
}

/** Soft two-note chime (Web Audio, no file). Quiet; skipped if audio is blocked. */
export function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.34);
    });
    setTimeout(() => void ctx.close(), 900);
  } catch {
    /* audio unavailable */
  }
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Browser notification if the user granted permission (asked from a button, never on load). */
export function notify(title: string, body: string) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: title + body });
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export function alertSummary(e: AlertEvent): { title: string; body: string } {
  const a = e.alert;
  const pc = a.pc < 1e-12 ? "< 1e−12" : a.pc.toExponential(1).replace("e-", "e−");
  return {
    title: `${e.replay ? "Replay · " : ""}${a.status}: ${a.primary_name}`,
    body: `vs ${a.secondary_name} · T−${Math.max(a.hours_to_tca, 0).toFixed(1)} h · miss ${a.miss_km.toFixed(2)} km · Pc ${pc}`,
  };
}

/**
 * Subscribe to /sentinel/stream (server-sent events). Alert events are de-duplicated per browser session, so a
 * reconnect or a second tab of the same session does not repeat a toast / sound / notification.
 */
export function useSentinelStream(handlers: StreamHandlers) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(SENTINEL_STREAM_URL);
    const seen = seenSet();
    const parse = <T,>(ev: MessageEvent): T | null => {
      try {
        return JSON.parse(ev.data as string) as T;
      } catch {
        return null;
      }
    };
    es.addEventListener("hello", (ev) => {
      const m = parse<{ status: SentinelStatus }>(ev as MessageEvent);
      if (m) ref.current.onHello?.(m.status);
    });
    es.addEventListener("run", (ev) => {
      const m = parse<{ phase: "started" | "finished"; status?: SentinelStatus }>(ev as MessageEvent);
      if (m) ref.current.onRun?.(m.phase, m.status);
    });
    es.addEventListener("replay", (ev) => {
      const m = parse<{ state: ReplayState }>(ev as MessageEvent);
      if (m) ref.current.onReplay?.(m.state);
    });
    es.addEventListener("alert", (ev) => {
      const m = parse<AlertEvent>(ev as MessageEvent);
      if (!m || seen.has(m.dedupe)) return;
      seen.add(m.dedupe);
      remember(seen);
      ref.current.onAlert?.(m);
    });
    es.addEventListener("alert_summary", (ev) => {
      const m = parse<{ dedupe: string; count: number; text: string }>(ev as MessageEvent);
      if (!m || seen.has(m.dedupe)) return;
      seen.add(m.dedupe);
      remember(seen);
      ref.current.onSummary?.(m);
    });
    return () => es.close();
  }, []);
}
