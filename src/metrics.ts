import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SessionMetric {
  command: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  costUSD: number;
  durationMs: number;
  timestamp: string;
}

const METRICS_DIR = path.join(os.homedir(), '.mythos-router');
const METRICS_FILE = path.join(METRICS_DIR, 'metrics.json');

export function ensureMetricsFile(): void {
  if (!fs.existsSync(METRICS_DIR)) {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
  }
  if (!fs.existsSync(METRICS_FILE)) {
    fs.writeFileSync(METRICS_FILE, JSON.stringify([]), 'utf-8');
  }
}

export function saveSessionMetric(metric: SessionMetric): void {
  try {
    ensureMetricsFile();
    const content = fs.readFileSync(METRICS_FILE, 'utf-8');
    const metrics: SessionMetric[] = JSON.parse(content);
    metrics.push(metric);
    // Keep the file bounded; retain the most recent entries.
    const MAX_METRICS = 5000;
    if (metrics.length > MAX_METRICS) {
      metrics.splice(0, metrics.length - MAX_METRICS);
    }
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), 'utf-8');
  } catch (err) {
    // Fail silently so we don't disrupt the user workflow
    console.error(`\x1b[91m✖ Failed to save metrics: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  }
}

export function loadSessionMetrics(): SessionMetric[] {
  try {
    ensureMetricsFile();
    const content = fs.readFileSync(METRICS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    return [];
  }
}
