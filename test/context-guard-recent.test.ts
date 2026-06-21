import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planContextCompression,
  MIN_RECENT_MESSAGES_KEPT,
  MAX_HISTORY_MESSAGES,
} from '../src/context-guard.js';

describe('planContextCompression keeps recent turns', () => {
  it('never compresses away the most recent MIN_RECENT_MESSAGES_KEPT messages (message-cap trigger)', () => {
    const lengths = Array(MAX_HISTORY_MESSAGES + 40).fill(100);
    const plan = planContextCompression(lengths, 0, 4, true);
    assert.ok(plan, 'expected a compression plan');
    const kept = lengths.length - plan!.messagesToCompress;
    assert.ok(
      kept >= MIN_RECENT_MESSAGES_KEPT,
      `kept only ${kept} of ${lengths.length}; must keep >= ${MIN_RECENT_MESSAGES_KEPT}`,
    );
  });

  it('keeps the recent floor even for a dense token-driven compression', () => {
    // ~20 messages of 80k chars each is far over the 150k token cap, so the
    // token target wants to shed almost everything — but the floor must hold.
    const lengths = Array(20).fill(80_000);
    const plan = planContextCompression(lengths, 0, 4, true);
    assert.ok(plan, 'expected a compression plan');
    const kept = lengths.length - plan!.messagesToCompress;
    assert.ok(kept >= MIN_RECENT_MESSAGES_KEPT, `kept only ${kept}`);
  });

  it('does not compress a history at or below the recent floor', () => {
    const lengths = Array(MIN_RECENT_MESSAGES_KEPT).fill(100);
    assert.equal(planContextCompression(lengths, 0, 4, true), null);
  });
});
