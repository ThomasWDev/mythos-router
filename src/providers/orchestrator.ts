import { createHash } from 'node:crypto';
import { TelemetryStore, type ProviderState as TelemetryProviderState } from './telemetry.js';
import {
  type BaseProvider,
  type Message,
  type StreamOptions,
  type SendOptions,
  type UnifiedResponse,
  type ProviderConfig,
  type ProviderStatus,
  type OrchestrationEvent,
  type ProviderFailureReason,
  ProviderError,
  isRetryableKind,
  kindFromStatus,
} from './types.js';
import { estimateCost } from './pricing.js';
import { extractStatusCode, failureReasonFromError } from './errors.js';
import { messagesCharLength, serializeMessageForRouting } from './messages.js';
import type { WorkspaceInput } from '../workspace.js';

// ── EMA-Based Model Metrics ──────────────────────────────────
interface ModelMetrics {
  successRate: number;   // EMA of success (0.0 - 1.0)
  avgLatency: number;    // EMA of latency in ms
  prevSuccessRate: number;
  prevAvgLatency: number;
  costPer1k: number;     // Average cost per 1k tokens
  totalCalls: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorTime: number;
}

// ── Provider Slot (runtime state) ────────────────────────────
interface ProviderSlot {
  provider: BaseProvider;
  config: ProviderConfig;
  status: ProviderStatus;
  metrics: ModelMetrics;
  activeConcurrency: number;
  degradedUntil: number;  // Timestamp when circuit breaker resets
  telemetryScope: string;
  telemetryModelId: string;
  telemetryEndpointHash: string;
}

type OrchestratorTelemetry = Pick<TelemetryStore, 'updateMetrics' | 'logDecision' | 'logFailure'> & {
  getProviderMetric?: (scopeKey: string) => TelemetryProviderState | null;
};

// ── Retry Configuration ──────────────────────────────────────
const RETRY_BACKOFFS_MS = [100, 500, 1000] as const;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 2;
const EMA_ALPHA = 0.3; // Smoothing factor for exponential moving average
const DEFAULT_WATCHDOG_MS = 15_000;
const WATCHDOG_LATENCY_MULTIPLIER = 3;

// ── Retryable Error Detection ────────────────────────────────
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  if (err instanceof ProviderError) {
    return err.retryable;
  }

  const status = extractStatusCode(err);
  if (status !== undefined) {
    return isRetryableKind(kindFromStatus(status));
  }

  const name = err.name.toLowerCase();
  const msg = err.message.toLowerCase();
  if (name === 'apiconnectiontimeouterror' || name === 'timeouterror') return true;
  if (name === 'apiconnectionerror') return true;

  if (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    msg.includes('fetch failed') ||
    msg.includes('network error')
  ) {
    return true;
  }

  // Last-resort compatibility for raw SDK errors that expose a status only in
  // the message. Match standalone tokens so request ids and byte counts cannot
  // masquerade as HTTP status codes.
  for (const code of [408, 429, 500, 501, 502, 503, 504, 529]) {
    const tokenRe = new RegExp(`(?<![0-9])${code}(?![0-9])`);
    if (tokenRe.test(msg)) return true;
  }

  return msg.includes('overloaded') || msg.includes('rate limit');
}

function cancellationFromSignal(signal?: AbortSignal): ProviderError {
  if (signal?.reason instanceof ProviderError) return signal.reason;
  const cause = signal?.reason;
  const detail = cause instanceof Error ? cause.message : 'request cancelled';
  return new ProviderError(detail, {
    kind: 'cancelled',
    retryable: false,
    cause,
  });
}

class ProviderAttemptFailure extends Error {
  constructor(
    readonly providerError: Error,
    readonly retryCount: number,
  ) {
    super(providerError.message, { cause: providerError });
    this.name = 'ProviderAttemptFailure';
  }
}

interface RetryResult<T> {
  value: T;
  retryCount: number;
}

// ── Scoring Algorithm ────────────────────────────────────────
function calculateScore(
  metrics: ModelMetrics,
  taskType: 'chat' | 'code' | 'analysis' | 'unknown' = 'chat',
): number {
  let latencyWeight = 0.05;
  let successWeight = 100;

  // Context-aware biasing
  if (taskType === 'chat') latencyWeight = 0.2;
  if (taskType === 'code' || taskType === 'analysis') successWeight = 150;

  return (
    (metrics.successRate * successWeight) -
    (metrics.avgLatency * latencyWeight) -
    (metrics.costPer1k * 10.0)
  );
}

// ── Deterministic Provider Selection ─────────────────────────
function deterministicSelect(
  messages: Message[],
  providers: ProviderSlot[],
): ProviderSlot {
  // Hash the input to get a stable provider index
  const payload = messages.map(serializeMessageForRouting).join('|');
  const hash = createHash('sha256').update(payload).digest();
  const index = hash.readUInt32BE(0) % providers.length;
  return providers[index];
}

// ── The Orchestrator ─────────────────────────────────────────
export class ProviderOrchestrator {
  private slots: ProviderSlot[] = [];
  private eventLog: OrchestrationEvent[] = [];
  private sessionId: string;
  private telemetry: OrchestratorTelemetry;
  private capacityWaiters = new Set<() => void>();

  constructor(telemetry?: OrchestratorTelemetry, workspaceInput?: WorkspaceInput) {
    this.sessionId = createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .slice(0, 12);
    if (telemetry) {
      this.telemetry = telemetry;
      return;
    }

    try {
      this.telemetry = TelemetryStore.getInstance(workspaceInput);
    } catch {
      this.telemetry = {
        updateMetrics: () => {},
        logDecision: () => {},
        logFailure: () => {}
      };
    }
  }

  // ── Provider Registration ────────────────────────────────
  registerProvider(provider: BaseProvider, config?: Partial<ProviderConfig>): void {
    const requestedMaxConcurrency = config?.maxConcurrency ?? 3;
    if (!Number.isInteger(requestedMaxConcurrency) || requestedMaxConcurrency < 1) {
      throw new Error(`Provider '${provider.id}' maxConcurrency must be a positive integer.`);
    }

    const fullConfig: ProviderConfig = {
      id: provider.id,
      priority: config?.priority ?? this.slots.length,
      enabled: config?.enabled ?? true,
      maxConcurrency: requestedMaxConcurrency,
    };

    const identity = provider.telemetryIdentity ?? { modelId: 'unknown', endpointHash: 'default' };
    const telemetryScope = `${provider.id}:${identity.modelId}:${identity.endpointHash}`;
    const persisted = this.telemetry.getProviderMetric?.(telemetryScope) ?? null;
    const degradedUntil = persisted?.degradedUntil ?? 0;

    this.slots.push({
      provider,
      config: fullConfig,
      status: degradedUntil > Date.now() ? 'degraded' : 'healthy',
      metrics: {
        successRate: persisted?.successRate ?? 1.0,
        avgLatency: persisted?.avgLatency ?? 1000,
        prevSuccessRate: persisted?.prevSuccessRate ?? 1.0,
        prevAvgLatency: persisted?.prevAvgLatency ?? 1000,
        costPer1k: persisted?.costPer1k ?? 0,
        totalCalls: persisted?.totalCalls ?? 0,
        totalFailures: persisted?.totalFailures ?? 0,
        consecutiveFailures: 0,
        lastError: null,
        lastErrorTime: 0,
      },
      activeConcurrency: 0,
      degradedUntil,
      telemetryScope,
      telemetryModelId: identity.modelId,
      telemetryEndpointHash: identity.endpointHash,
    });
  }

  // ── Provider Selection (Scored or Deterministic) ─────────
  private selectProvider(
    messages: Message[],
    options: StreamOptions | SendOptions,
  ): ProviderSlot[] {
    const now = Date.now();

    // Reset expired circuit breakers
    for (const slot of this.slots) {
      if (slot.status === 'degraded' && now >= slot.degradedUntil) {
        slot.status = 'healthy';
      }
    }

    const routable = this.slots.filter(slot =>
      slot.config.enabled && slot.status !== 'down'
    );
    if (routable.length === 0) {
      throw new Error('No providers available. All registered providers are down or disabled.');
    }

    // Forced and deterministic routing select from all routable providers and
    // then wait for their hard concurrency slot. Saturation must not silently
    // change an explicitly requested or deterministic provider.
    if (options.forceProvider) {
      const forced = routable.find(s => s.provider.id === options.forceProvider);
      if (!forced) {
        throw new Error(`Forced provider '${options.forceProvider}' is not available or disabled.`);
      }
      return [forced];
    }
    if (options.deterministic) {
      return [deterministicSelect(messages, routable)];
    }

    // Adaptive routing prefers providers with immediate capacity. If every
    // provider is saturated, keep all candidates and queue until the first hard
    // slot becomes available rather than exceeding maxConcurrency.
    const available = routable.filter(
      slot => slot.activeConcurrency < slot.config.maxConcurrency,
    );
    const eligible = available.length > 0 ? available : routable;

    // Adaptive mode: sort by score (highest first)
    const taskType = options.taskType ?? 'unknown';
    eligible.sort((a, b) => {
      // Healthy providers always beat degraded ones
      if (a.status === 'healthy' && b.status === 'degraded') return -1;
      if (a.status === 'degraded' && b.status === 'healthy') return 1;

      const scoreA = calculateScore(a.metrics, taskType);
      const scoreB = calculateScore(b.metrics, taskType);

      // Tie-breaker: if scores are virtually identical (e.g., at startup),
      // respect the explicitly configured provider priority.
      if (Math.abs(scoreA - scoreB) < 0.01) {
        return a.config.priority - b.config.priority;
      }

      return scoreB - scoreA;
    });

    return eligible;
  }

  // ── Update Metrics (EMA) ─────────────────────────────────
  private recordSuccess(slot: ProviderSlot, latencyMs: number, costPer1k: number): void {
    const m = slot.metrics;
    m.prevSuccessRate = m.successRate;
    m.prevAvgLatency = m.avgLatency;
    m.successRate = m.successRate * (1 - EMA_ALPHA) + 1.0 * EMA_ALPHA;
    m.avgLatency = m.avgLatency * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;
    m.costPer1k = costPer1k > 0
      ? m.costPer1k * (1 - EMA_ALPHA) + costPer1k * EMA_ALPHA
      : m.costPer1k;
    m.totalCalls++;
    m.consecutiveFailures = 0;
    this.pushTelemetryState(slot);
  }

  private recordFailure(slot: ProviderSlot, err: Error): void {
    const m = slot.metrics;
    m.prevSuccessRate = m.successRate;
    m.prevAvgLatency = m.avgLatency;
    m.successRate = m.successRate * (1 - EMA_ALPHA);
    m.totalCalls++;
    m.totalFailures++;
    m.consecutiveFailures++;
    m.lastError = err.message;
    m.lastErrorTime = Date.now();
    this.pushTelemetryState(slot);
  }

  private maybeTripCircuitBreaker(slot: ProviderSlot, err: Error): void {
    if (
      isRetryableError(err) &&
      slot.metrics.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD
    ) {
      this.tripCircuitBreaker(slot);
    }
  }

  private tripCircuitBreaker(slot: ProviderSlot): void {
    slot.status = 'degraded';
    slot.degradedUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    this.pushTelemetryState(slot);
  }

  private pushTelemetryState(slot: ProviderSlot): void {
    this.telemetry.updateMetrics({
      id: slot.provider.id,
      scopeKey: slot.telemetryScope,
      modelId: slot.telemetryModelId,
      endpointHash: slot.telemetryEndpointHash,
      successRate: slot.metrics.successRate,
      avgLatency: slot.metrics.avgLatency,
      prevSuccessRate: slot.metrics.prevSuccessRate,
      prevAvgLatency: slot.metrics.prevAvgLatency,
      costPer1k: slot.metrics.costPer1k,
      totalCalls: slot.metrics.totalCalls,
      totalFailures: slot.metrics.totalFailures,
      degradedUntil: slot.degradedUntil
    });
  }

  // ── Adaptive Watchdog Timeout ────────────────────────────
  private getWatchdogTimeout(slot: ProviderSlot): number {
    return Math.max(DEFAULT_WATCHDOG_MS, slot.metrics.avgLatency * WATCHDOG_LATENCY_MULTIPLIER);
  }

  // ── Hard Concurrency Admission ────────────────────────────
  private async acquireCandidate(
    candidates: ProviderSlot[],
    attempted: ReadonlySet<ProviderSlot>,
    signal?: AbortSignal,
  ): Promise<ProviderSlot | null> {
    while (true) {
      if (signal?.aborted) throw cancellationFromSignal(signal);

      const remaining = candidates.filter(slot => !attempted.has(slot));
      if (remaining.length === 0) return null;

      const available = remaining.find(
        slot => slot.activeConcurrency < slot.config.maxConcurrency,
      );
      if (available) {
        available.activeConcurrency++;
        return available;
      }

      await this.waitForCapacity(signal);
    }
  }

  private waitForCapacity(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancellationFromSignal(signal));

    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(cancellationFromSignal(signal));
      };
      const cleanup = () => {
        this.capacityWaiters.delete(wake);
        signal?.removeEventListener('abort', onAbort);
      };

      this.capacityWaiters.add(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseCandidate(slot: ProviderSlot): void {
    slot.activeConcurrency = Math.max(0, slot.activeConcurrency - 1);
    if (this.capacityWaiters.size === 0) return;

    // Wake every waiter. Each re-checks the hard cap synchronously before it can
    // acquire a slot, so no provider can exceed maxConcurrency. Broadcasting
    // avoids starving a waiter whose forced provider differs from the slot that
    // just became available.
    const waiters = [...this.capacityWaiters];
    this.capacityWaiters.clear();
    for (const wake of waiters) wake();
  }

  // ── Retry with Exponential Backoff ───────────────────────
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<RetryResult<T>> {
    let retryCount = 0;

    for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
      if (signal?.aborted) {
        throw new ProviderAttemptFailure(cancellationFromSignal(signal), retryCount);
      }

      try {
        return { value: await fn(), retryCount };
      } catch (error) {
        const providerError = error instanceof Error ? error : new Error(String(error));

        if (signal?.aborted) {
          throw new ProviderAttemptFailure(cancellationFromSignal(signal), retryCount);
        }
        if (!isRetryableError(providerError) || attempt >= RETRY_BACKOFFS_MS.length) {
          throw new ProviderAttemptFailure(providerError, retryCount);
        }

        retryCount++;
        const delay = RETRY_BACKOFFS_MS[attempt];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, delay);

          const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(new ProviderAttemptFailure(cancellationFromSignal(signal), retryCount));
          };
          const cleanup = () => signal?.removeEventListener('abort', onAbort);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    }

    throw new ProviderAttemptFailure(new Error('Retry loop exhausted unexpectedly.'), retryCount);
  }

  // ── Stream Message (Primary API) ─────────────────────────
  private logRoutingDecision(
    messages: Message[],
    taskType: 'chat' | 'code' | 'analysis' | 'unknown',
    candidates: ProviderSlot[]
  ): void {
    if (candidates.length === 0) return;

    const totalChars = messagesCharLength(messages);
    const tokenEstimate = Math.ceil(totalChars / 4);
    let bucket = '<4k';
    if (tokenEstimate >= 4000 && tokenEstimate < 16000) bucket = '4k-16k';
    else if (tokenEstimate >= 16000) bucket = '>16k';

    const winner = candidates[0];
    let reasoning = `Selected as only viable provider.`;
    if (candidates.length > 1) {
      const runnerUp = candidates[1];
      const winScore = calculateScore(winner.metrics, taskType).toFixed(1);
      const runScore = calculateScore(runnerUp.metrics, taskType).toFixed(1);
      reasoning = `Score (${winScore}) beat ${runnerUp.provider.id} (${runScore}). EMA Latency: ${winner.metrics.avgLatency.toFixed(0)}ms vs ${runnerUp.metrics.avgLatency.toFixed(0)}ms.`;
    }

    this.telemetry.logDecision({
      timestamp: Date.now(),
      selectedProvider: winner.provider.id,
      selectedScope: winner.telemetryScope,
      taskType,
      inputSizeBucket: bucket,
      reasoning
    });
  }

  async streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse> {
    const candidates = this.selectProvider(messages, options);
    const taskType = options.taskType ?? 'unknown';
    this.logRoutingDecision(messages, taskType, candidates);

    const primaryProvider = candidates[0]?.provider.id ?? 'none';
    const attempted = new Set<ProviderSlot>();
    let totalRetryCount = 0;
    let fallbackCount = 0;
    let lastFallbackReason: ProviderFailureReason | undefined;

    while (true) {
      const slot = await this.acquireCandidate(candidates, attempted, options.signal);
      if (!slot) break;
      attempted.add(slot);

      let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const watchdogMs = options.timeoutMs ?? this.getWatchdogTimeout(slot);
        const watchdogController = new AbortController();
        const compositeSignal = options.signal
          ? AbortSignal.any([options.signal, watchdogController.signal])
          : watchdogController.signal;

        const resetWatchdog = () => {
          if (watchdogTimer) clearTimeout(watchdogTimer);
          watchdogTimer = setTimeout(() => {
            watchdogController.abort(new ProviderError(
              `[${slot.provider.id}] stream watchdog timed out after ${Math.round(watchdogMs)}ms`,
              {
                kind: 'timeout',
                providerId: slot.provider.id,
              },
            ));
          }, watchdogMs);
        };
        resetWatchdog();

        const wrappedOptions: StreamOptions = {
          ...options,
          signal: compositeSignal,
          onThinkingDelta: (text) => {
            resetWatchdog();
            options.onThinkingDelta?.(text);
          },
          onTextDelta: (text) => {
            resetWatchdog();
            options.onTextDelta?.(text);
          },
        };

        const attempt = await this.retryWithBackoff(
          () => slot.provider.streamMessage(messages, wrappedOptions),
          compositeSignal,
        );
        totalRetryCount += attempt.retryCount;
        const response = attempt.value;

        if (response.metadata.incomplete) {
          if (options.signal?.aborted) throw cancellationFromSignal(options.signal);
          if (watchdogController.signal.aborted) {
            throw cancellationFromSignal(watchdogController.signal);
          }
          throw new ProviderError(
            `[${slot.provider.id}] returned an incomplete response`,
            {
              kind: 'incomplete_response',
              providerId: slot.provider.id,
            },
          );
        }

        const cost = estimateCost(
          response.metadata.modelId,
          response.usage.inputTokens,
          response.usage.outputTokens,
          slot.provider.id,
        );
        this.recordSuccess(slot, response.usage.latencyMs, cost.costPer1k);
        response.metadata.fallbackTriggered = fallbackCount > 0;

        this.logEvent({
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          command: 'stream',
          primaryProvider,
          actualProvider: slot.provider.id,
          fallbackReason: lastFallbackReason,
          latencyMs: response.usage.latencyMs,
          cost: cost.totalCost,
          costPer1k: cost.costPer1k,
          retryCount: totalRetryCount,
          fallbackCount,
        });

        return response;
      } catch (rawError) {
        const failure = rawError instanceof ProviderAttemptFailure
          ? rawError
          : new ProviderAttemptFailure(
            rawError instanceof Error ? rawError : new Error(String(rawError)),
            0,
          );
        totalRetryCount += failure.retryCount;
        const error = failure.providerError;

        if (options.signal?.aborted) {
          throw cancellationFromSignal(options.signal);
        }

        this.recordFailure(slot, error);
        this.maybeTripCircuitBreaker(slot, error);
        const reason = failureReasonFromError(error);

        this.telemetry.logFailure({
          timestamp: Date.now(),
          provider: slot.provider.id,
          providerScope: slot.telemetryScope,
          errorType: reason,
          shortMessage: error.message.slice(0, 100),
          fullStack: error.stack || error.message,
        });

        this.logEvent({
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          command: 'stream',
          primaryProvider,
          actualProvider: slot.provider.id,
          fallbackReason: reason,
          latencyMs: 0,
          cost: 0,
          costPer1k: 0,
          retryCount: totalRetryCount,
          fallbackCount,
        });

        if (options.allowFallback === false) throw error;
        if (options.deterministic) {
          throw new Error(
            `[orchestrator] Deterministic mode: ${slot.provider.id} failed and fallback is disabled. ` +
            `Error: ${error.message}`,
            { cause: error },
          );
        }

        if (attempted.size < candidates.length) {
          lastFallbackReason = reason;
          fallbackCount++;
          continue;
        }
        break;
      } finally {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        this.releaseCandidate(slot);
      }
    }

    throw new Error('[orchestrator] All providers exhausted. No response generated.');
  }

  // ── Send Message (Non-Streaming) ─────────────────────────
  async sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse> {
    const candidates = this.selectProvider(messages, options);
    const taskType = options.taskType ?? 'unknown';
    this.logRoutingDecision(messages, taskType, candidates);

    const primaryProvider = candidates[0]?.provider.id ?? 'none';
    const attempted = new Set<ProviderSlot>();
    let totalRetryCount = 0;
    let fallbackCount = 0;
    let lastFallbackReason: ProviderFailureReason | undefined;

    while (true) {
      const slot = await this.acquireCandidate(candidates, attempted, options.signal);
      if (!slot) break;
      attempted.add(slot);

      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        let requestSignal = options.signal;
        if (options.timeoutMs !== undefined) {
          const timeoutMs = options.timeoutMs;
          const timeoutController = new AbortController();
          timeoutTimer = setTimeout(() => {
            timeoutController.abort(new ProviderError(
              `[${slot.provider.id}] request timed out after ${Math.round(timeoutMs)}ms`,
              {
                kind: 'timeout',
                providerId: slot.provider.id,
              },
            ));
          }, timeoutMs);
          requestSignal = options.signal
            ? AbortSignal.any([options.signal, timeoutController.signal])
            : timeoutController.signal;
        }

        const attempt = await this.retryWithBackoff(
          () => slot.provider.sendMessage(messages, { ...options, signal: requestSignal }),
          requestSignal,
        );
        totalRetryCount += attempt.retryCount;
        const response = attempt.value;

        if (response.metadata.incomplete) {
          if (options.signal?.aborted) throw cancellationFromSignal(options.signal);
          if (requestSignal?.aborted) throw cancellationFromSignal(requestSignal);
          throw new ProviderError(
            `[${slot.provider.id}] returned an incomplete response`,
            {
              kind: 'incomplete_response',
              providerId: slot.provider.id,
            },
          );
        }

        const cost = estimateCost(
          response.metadata.modelId,
          response.usage.inputTokens,
          response.usage.outputTokens,
          slot.provider.id,
        );
        this.recordSuccess(slot, response.usage.latencyMs, cost.costPer1k);
        response.metadata.fallbackTriggered = fallbackCount > 0;

        this.logEvent({
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          command: 'send',
          primaryProvider,
          actualProvider: slot.provider.id,
          fallbackReason: lastFallbackReason,
          latencyMs: response.usage.latencyMs,
          cost: cost.totalCost,
          costPer1k: cost.costPer1k,
          retryCount: totalRetryCount,
          fallbackCount,
        });

        return response;
      } catch (rawError) {
        const failure = rawError instanceof ProviderAttemptFailure
          ? rawError
          : new ProviderAttemptFailure(
            rawError instanceof Error ? rawError : new Error(String(rawError)),
            0,
          );
        totalRetryCount += failure.retryCount;
        const error = failure.providerError;

        if (options.signal?.aborted) {
          throw cancellationFromSignal(options.signal);
        }

        this.recordFailure(slot, error);
        this.maybeTripCircuitBreaker(slot, error);
        const reason = failureReasonFromError(error);

        this.telemetry.logFailure({
          timestamp: Date.now(),
          provider: slot.provider.id,
          providerScope: slot.telemetryScope,
          errorType: reason,
          shortMessage: error.message.slice(0, 100),
          fullStack: error.stack || error.message,
        });

        this.logEvent({
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          command: 'send',
          primaryProvider,
          actualProvider: slot.provider.id,
          fallbackReason: reason,
          latencyMs: 0,
          cost: 0,
          costPer1k: 0,
          retryCount: totalRetryCount,
          fallbackCount,
        });

        if (options.allowFallback === false) throw error;
        if (options.deterministic) {
          throw new Error(
            `[orchestrator] Deterministic mode: ${slot.provider.id} failed. Error: ${error.message}`,
            { cause: error },
          );
        }

        if (attempted.size < candidates.length) {
          lastFallbackReason = reason;
          fallbackCount++;
          continue;
        }
        break;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.releaseCandidate(slot);
      }
    }

    throw new Error('[orchestrator] All providers exhausted. No response generated.');
  }

  // ── Observability ────────────────────────────────────────
  private logEvent(event: OrchestrationEvent): void {
    this.eventLog.push(event);
    // Keep last 200 events in memory
    if (this.eventLog.length > 200) {
      this.eventLog = this.eventLog.slice(-200);
    }
  }

  getEventLog(): readonly OrchestrationEvent[] {
    return this.eventLog;
  }

  getProviderHealth(): Array<{
    id: string;
    status: ProviderStatus;
    score: number;
    metrics: ModelMetrics;
    concurrency: number;
  }> {
    return this.slots.map(slot => ({
      id: slot.provider.id,
      status: slot.status,
      score: calculateScore(slot.metrics),
      metrics: { ...slot.metrics },
      concurrency: slot.activeConcurrency,
    }));
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // ── Provider Count ───────────────────────────────────────
  get providerCount(): number {
    return this.slots.filter(s => s.config.enabled).length;
  }
}
