export interface PerformanceMeasure {
  name: string;
  durationMs: number;
  startMark: string;
  endMark: string;
  at: string;
}

export interface PerformanceRequest {
  method: string;
  url: string;
  startedAt: number;
  durationMs: number;
  at?: string;
  status: number;
  serverTiming: string | null;
  failed?: boolean;
}

const marks = new Map<string, number>();
const measures: PerformanceMeasure[] = [];
const requests: PerformanceRequest[] = [];
const MAX_REQUESTS = 120;

function now(): number {
  return performance.now();
}

function isVerbose(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem('cp-coach:perf') === '1';
  } catch {
    return false;
  }
}

function publish(): void {
  if (typeof window === 'undefined') return;
  (window as typeof window & { __CP_COACH_PERF__?: unknown }).__CP_COACH_PERF__ = {
    navigation: navigationSummary(),
    marks: Object.fromEntries(marks),
    measures,
    requests,
  };
}

export function perfMark(name: string, startTime?: number): void {
  const timestamp = startTime ?? now();
  marks.set(name, timestamp);
  try {
    performance.mark(`cp-coach:${name}`, { startTime: timestamp });
  } catch {
    try {
      performance.mark(`cp-coach:${name}`);
    } catch {
      // Ignore environments without the User Timing API.
    }
  }
  publish();
}

export function perfMarkNavigationStart(): void {
  perfMark('navigation-start', 0);
}

export function perfMeasure(name: string, startMark: string, endMark = name): number {
  const startedAt = marks.get(startMark);
  const endedAt = marks.get(endMark);
  if (startedAt === undefined || endedAt === undefined) return 0;
  const durationMs = Math.max(0, endedAt - startedAt);
  measures.push({
    name,
    durationMs: Math.round(durationMs * 10) / 10,
    startMark,
    endMark,
    at: new Date().toISOString(),
  });
  try {
    performance.measure(`cp-coach:${name}`, `cp-coach:${startMark}`, `cp-coach:${endMark}`);
  } catch {
    // Ignore environments without the User Timing API.
  }
  if (isVerbose()) {
    console.info(`[CP Coach perf] ${name}: ${durationMs.toFixed(1)}ms`);
  }
  publish();
  return durationMs;
}

export function navigationSummary(): Record<string, number | null> {
  if (typeof performance === 'undefined') return {};
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!navigation) return {};
  return {
    timeOrigin: Math.round(performance.timeOrigin),
    domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
    loadEventMs: Math.round(navigation.loadEventEnd),
    responseStartMs: Math.round(navigation.responseStart),
  };
}

export function recordRequest(request: Omit<PerformanceRequest, 'at' | 'startedAt'> & { startedAt: number; at?: string }): void {
  requests.push({
    ...request,
    startedAt: Math.round(request.startedAt * 10) / 10,
    durationMs: Math.round(request.durationMs * 10) / 10,
    at: request.at || new Date().toISOString(),
  });
  if (requests.length > MAX_REQUESTS) requests.splice(0, requests.length - MAX_REQUESTS);
  publish();
}

export function perfSummary(): Record<string, unknown> {
  return {
    navigation: navigationSummary(),
    measures: [...measures],
    requests: [...requests],
  };
}

export function installPerf(): void {
  publish();
}
