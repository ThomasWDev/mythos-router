/**
 * Small, dependency-free helpers for fail-closed JSON object validation.
 *
 * Security-sensitive configuration and agent envelopes should never silently
 * ignore misspelled properties. These helpers keep the error style consistent
 * without introducing a runtime schema-validator dependency.
 */
export function unknownPropertyErrors(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): string[] {
  const allowed = new Set(allowedKeys);
  const errors: string[] = [];

  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    const suggestion = closestKey(key, allowedKeys);
    errors.push(
      `Unknown ${context} key "${key}".` +
      (suggestion ? ` Did you mean "${suggestion}"?` : ''),
    );
  }

  return errors;
}

export function assertKnownProperties(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  const errors = unknownPropertyErrors(value, allowedKeys, context);
  if (errors.length > 0) throw new Error(errors.join(' '));
}

function closestKey(input: string, candidates: readonly string[]): string | undefined {
  const normalizedInput = input.toLowerCase();
  let best: { key: string; distance: number } | undefined;

  for (const candidate of candidates) {
    const distance = levenshtein(normalizedInput, candidate.toLowerCase());
    if (!best || distance < best.distance) best = { key: candidate, distance };
  }

  if (!best) return undefined;
  const threshold = Math.max(1, Math.min(3, Math.floor(Math.max(input.length, best.key.length) / 3)));
  return best.distance <= threshold ? best.key : undefined;
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[right.length]!;
}
