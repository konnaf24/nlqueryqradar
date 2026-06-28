# qradar-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes IBM QRadar SIEM capabilities as callable tools for LLM clients such as Claude Desktop. It lets analysts query QRadar in natural language — the LLM translates intent into AQL or structured filters, and this server executes the calls against the QRadar REST API.

See [`SPEC.md`](./SPEC.md) for the full technical specification.

## Features

The server registers five MCP tools:

| Tool | Description |
|---|---|
| `run_aql_query` | Execute an arbitrary AQL query against the Ariel database. |
| `search_events` | Search event logs using structured filters (source/dest IP, username, event name, time window). |
| `get_offenses` | Retrieve offenses, optionally filtered by status and minimum magnitude. |
| `list_log_sources` | List all configured log sources. |
| `search_assets` | Query the asset model by IP or hostname. |

## Requirements

- Node.js 18+
- An IBM QRadar deployment (API v20.0+ / QRadar 7.3+)
- A QRadar **Authorized Service** token with the required capabilities (see [SPEC §9](./SPEC.md#9-required-qradar-permissions))

## Installation

```bash
npm install
npm run build
```

## Configuration

Configuration is supplied entirely through environment variables. Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `QRADAR_URL` | Yes | — | Base URL of the QRadar console, e.g. `https://qradar.corp.com` |
| `QRADAR_API_TOKEN` | Yes | — | Authorized service token (SEC header value) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | unset | Set to `1` to enforce strict TLS; leave unset/`0` to allow self-signed certs |
| `QRADAR_TIMEOUT_MS` | No | `30000` | HTTP request timeout (ms) |
| `QRADAR_POLL_INTERVAL_MS` | No | `1000` | AQL search poll interval (ms) |
| `QRADAR_MAX_POLL_ATTEMPTS` | No | `60` | Max AQL poll attempts before timeout |

The server fails fast (exit code 1) if `QRADAR_URL` or `QRADAR_API_TOKEN` is missing.

## Usage

### Run directly

```bash
npm start          # node dist/index.js (requires build first)
npm run dev        # tsx src/index.ts (no build step, dev only)
```

The server speaks JSON-RPC 2.0 over stdio — it is launched as a child process by an MCP client and opens no network port of its own.

### Claude Desktop

Add the server to your Claude Desktop MCP configuration
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "qradar": {
      "command": "node",
      "args": ["/absolute/path/to/qradar-mcp/dist/index.js"],
      "env": {
        "QRADAR_URL": "https://qradar.corp.com",
        "QRADAR_API_TOKEN": "your-authorized-service-token"
      }
    }
  }
}
```

Restart Claude Desktop, and the QRadar tools become available to the model.

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run dev` | Run from source via `tsx` |
| `npm run typecheck` | Type-check without emitting |

## Security

- The API token is read from the environment and sent only as the `SEC` header. It is never logged or returned in tool output.
- The MCP server opens no listening port; egress is outbound-only to the configured QRadar host.
- AQL is forwarded as-is to QRadar, which enforces read-only semantics. See [SPEC §8](./SPEC.md#8-security) for details and the trust model.

## License

MIT
