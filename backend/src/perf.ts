import { performance } from 'node:perf_hooks';

export interface TimingSink {
  add(name: string, durationMs: number): void;
}

export interface TimingSpan {
  name: string;
  durationMs: number;
}

const LOG_TIMINGS = process.env.PERF_TIMINGS === 'true';
const MAX_SPANS = 80;

function roundDuration(value: number): number {
  return Math.round(value * 10) / 10;
}

export class PerfTrace implements TimingSink {
  private readonly startedAt = performance.now();
  private readonly openSpans = new Map<string, number>();
  private readonly spans: TimingSpan[] = [];

  constructor(
    private readonly label: string,
    private readonly context: Record<string, unknown> = {},
  ) {}

  start(name: string): void {
    if (!LOG_TIMINGS) return;
    this.openSpans.set(name, performance.now());
  }

  end(name: string): number {
    if (!LOG_TIMINGS) return 0;
    const startedAt = this.openSpans.get(name);
    if (startedAt === undefined) return 0;
    this.openSpans.delete(name);
    const durationMs = performance.now() - startedAt;
    this.add(name, durationMs);
    return durationMs;
  }

  add(name: string, durationMs: number): void {
    if (!LOG_TIMINGS || this.spans.length >= MAX_SPANS) return;
    this.spans.push({ name, durationMs: roundDuration(durationMs) });
  }

  async measure<T>(name: string, task: () => Promise<T> | T): Promise<T> {
    this.start(name);
    try {
      return await task();
    } finally {
      this.end(name);
    }
  }

  totalMs(): number {
    return roundDuration(performance.now() - this.startedAt);
  }

  serverTimingHeader(): string {
    if (!LOG_TIMINGS) return '';
    const metrics = this.spans.map((span) => (
      `${span.name.replace(/[^A-Za-z0-9_-]/g, '_')};dur=${span.durationMs.toFixed(1)}`
    ));
    metrics.push(`total;dur=${this.totalMs().toFixed(1)}`);
    return metrics.join(', ');
  }

  log(extra: Record<string, unknown> = {}): void {
    if (!LOG_TIMINGS) return;
    console.log(JSON.stringify({
      scope: 'perf',
      label: this.label,
      totalMs: this.totalMs(),
      ...this.context,
      ...extra,
      spans: this.spans,
    }));
  }
}

export function attachServerTiming(trace: PerfTrace, headers: Headers | { setHeader: (name: string, value: string) => void }): void {
  if (!LOG_TIMINGS) return;
  const value = trace.serverTimingHeader();
  if (!value) return;
  if (typeof (headers as { setHeader?: unknown }).setHeader === 'function') {
    (headers as { setHeader: (name: string, value: string) => void }).setHeader('Server-Timing', value);
  }
}
