// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/chat-types.ts
//  Shared option/context shapes for the chat & run command surface.
//
//  These interfaces are intentionally dependency-light so both chat.ts
//  (the orchestrator) and run-input.ts (the run-mode plumbing) can import
//  them without creating a value import cycle.
// ─────────────────────────────────────────────────────────────

import type { ReceiptProvider, ReceiptUsage } from '../receipts.js';

export interface ChatOptions {
  mode?: 'chat' | 'run';
  effort?: string;
  maxTokens?: string;
  maxTurns?: string;
  budget?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  branch?: string;
  testCmd?: string;
  maxTestRetries?: string;
  testTimeout?: string;
  skill?: string | string[];
  provider?: string;
  fallback?: boolean;
  resume?: boolean;
  escalate?: boolean;
  escalateTo?: string;
  // Opt-in (--tools): route file operations through native provider
  // tool-calling instead of text FILE_ACTION blocks (auto-falls back to text).
  tools?: boolean;
}

export interface RunOptions extends Omit<ChatOptions, 'mode' | 'resume'> {
  file?: string;
  stdin?: boolean;
}

export interface ReceiptContext {
  provider?: ReceiptProvider;
  usage?: Omit<ReceiptUsage, 'totalTokens'>;
}
