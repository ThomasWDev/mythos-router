export const MCP_CONFIG_CLIENTS = ['generic', 'claude', 'cursor'] as const;

export type MCPConfigClient = typeof MCP_CONFIG_CLIENTS[number];

export interface MCPServerConfig {
  mcpServers: {
    'mythos-router': {
      command: string;
      args: string[];
    };
  };
}

const CLIENT_LABELS: Record<MCPConfigClient, string> = {
  generic: 'MCP client',
  claude: 'Claude',
  cursor: 'Cursor',
};

export function isMCPConfigClient(value: string): value is MCPConfigClient {
  return (MCP_CONFIG_CLIENTS as readonly string[]).includes(value);
}

export function normalizeMCPConfigClient(value?: string): MCPConfigClient {
  if (!value) return 'generic';
  const normalized = value.toLowerCase();
  if (isMCPConfigClient(normalized)) return normalized;
  throw new Error(`Unknown MCP client "${value}". Valid clients: ${MCP_CONFIG_CLIENTS.join(', ')}`);
}

export function createMCPServerConfig(command = 'mythos'): MCPServerConfig {
  return {
    mcpServers: {
      'mythos-router': {
        command,
        args: ['mcp'],
      },
    },
  };
}

export function renderMCPConfig(client?: string, command = 'mythos'): string {
  const normalizedClient = normalizeMCPConfigClient(client);
  const title = CLIENT_LABELS[normalizedClient];
  const config = JSON.stringify(createMCPServerConfig(command), null, 2);
  const clientNote = normalizedClient === 'cursor'
    ? 'Add this to Cursor MCP settings or a project-level .cursor/mcp.json.'
    : normalizedClient === 'claude'
      ? 'Add this server entry to your Claude MCP configuration.'
      : 'Add this server entry to any MCP client that supports stdio servers.';

  return [
    `Mythos MCP config (${title})`,
    '',
    clientNote,
    '',
    config,
    '',
    'The client will launch `mythos mcp` locally over stdio when it needs Mythos tools.',
    'Run the client from the repository you want Mythos to guard, or use a project-scoped MCP config when your client supports it.',
  ].join('\n');
}
