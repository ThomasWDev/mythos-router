import { runMCPServer } from '../mcp.js';
import {
  createMCPServerConfig,
  isMCPConfigClient,
  normalizeMCPConfigClient,
  renderMCPConfig,
} from '../mcp-config.js';

interface MCPCommandOptions {
  json?: boolean;
  command?: string;
}

export async function mcpCommand(
  action = 'server',
  client?: string,
  options: MCPCommandOptions = {},
): Promise<void> {
  let normalizedAction = action.toLowerCase();
  let selectedClient = client;

  if (isMCPConfigClient(normalizedAction) && selectedClient === undefined) {
    selectedClient = normalizedAction;
    normalizedAction = 'config';
  }

  if (normalizedAction === 'server' || normalizedAction === 'run') {
    await runMCPServer();
    return;
  }

  if (normalizedAction === 'config') {
    const command = options.command ?? 'mythos';
    try {
      normalizeMCPConfigClient(selectedClient);
      if (options.json) {
        console.log(JSON.stringify(createMCPServerConfig(command), null, 2));
      } else {
        console.log(renderMCPConfig(selectedClient, command));
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Unknown mcp action: ${action}`);
  console.error('Usage: mythos mcp | mythos mcp config [generic|claude|cursor]');
  process.exitCode = 1;
}
