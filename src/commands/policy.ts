import { suggestProjectPolicy, type PolicySuggestionResult } from '../policy-suggestions.js';
import { c, heading, info, theme, warn } from '../utils.js';

interface PolicyOptions {
  json?: boolean;
}

export async function policyCommand(action?: string, options: PolicyOptions = {}): Promise<void> {
  const normalizedAction = (action ?? 'suggest').toLowerCase();

  if (normalizedAction !== 'suggest') {
    warn(`Unknown policy action: ${normalizedAction}`);
    info('Usage: mythos policy suggest --json');
    process.exitCode = 1;
    return;
  }

  const result = suggestProjectPolicy();
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printPolicySuggestions(result);
}

function printPolicySuggestions(result: PolicySuggestionResult): void {
  console.log(heading('Policy Suggestions'));
  if (result.suggestions.length === 0) {
    info('No new project policy suggestions found.');
    return;
  }

  for (const suggestion of result.suggestions) {
    const label = suggestion.risk === 'block'
      ? `${theme.error}BLOCK${c.reset}`
      : `${theme.warning}CONFIRM${c.reset}`;
    console.log(`  ${label} ${c.bold}${suggestion.pattern}${c.reset}`);
    console.log(`     ${c.dim}${suggestion.reason}${c.reset}`);
    console.log(`     ${c.dim}evidence: ${suggestion.evidence}${c.reset}`);
  }

  console.log();
  console.log(`${c.bold}Suggested policy patch${c.reset}`);
  console.log(JSON.stringify(result.policyPatch, null, 2));
  console.log();
  for (const note of result.notes) {
    console.log(`${c.dim}${note}${c.reset}`);
  }
}
