# QRadar MCP Server — Technical Specification

**Version:** 1.0.0  
**Status:** Draft  
**Last updated:** 2026-06-28

---

## 1. Overview

This document specifies the design, interfaces, behaviour, and constraints of `qradar-mcp`, a Model Context Protocol (MCP) server that exposes IBM QRadar SIEM capabilities as callable tools for LLM-based clients (primarily Claude Desktop).

### 1.1 Goals

- Enable natural language querying of QRadar without analyst knowledge of AQL.
- Provide a stable, typed MCP tool surface over the QRadar REST API.
- Be lightweight, stateless, and easy to self-host alongside an existing QRadar deployment.

### 1.2 Non-goals

- This server does not generate AQL from natural language itself — that is the responsibility of the LLM client.
- This server does not store or cache QRadar data.
- This server does not replace the QRadar UI or provide administrative functions (rule management, DSM configuration, etc.).
- Multi-tenant / multi-QRadar-instance support is out of scope for v1.0.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Claude Desktop                      │
│                                                     │
│   User prompt ──► Claude LLM ──► tool_use call      │
└──────────────────────┬──────────────────────────────┘
                       │ MCP (stdio / JSON-RPC 2.0)
┌──────────────────────▼──────────────────────────────┐
│                  qradar-mcp                          │
│                                                     │
│  McpServer (SDK)                                    │
│  ├── Tool registry (run_aql_query, search_events …) │
│  ├── Input validation (Zod schemas)                 │
│  └── QRadar REST client (axios)                     │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS / REST
┌──────────────────────▼──────────────────────────────┐
│               IBM QRadar SIEM                        │
│  /api/ariel/searches   (events, flows)               │
│  /api/siem/offenses                                  │
│  /api/asset_model/assets                            │
│  /api/config/event_sources/…                        │
└─────────────────────────────────────────────────────┘
```

### 2.1 Transport

The server uses **stdio transport** (stdin/stdout JSON-RPC 2.0) as defined by the MCP spec. This means it is launched as a child process by the MCP client and communicates over standard streams. No HTTP server or port is opened by the MCP layer.

### 2.2 Statefulness

The server is **stateless between tool calls**. Each tool invocation opens a fresh request to the QRadar REST API. No session, cache, or in-memory store is maintained.

---

## 3. Runtime environment

| Property | Value |
|---|---|
| Runtime | Node.js 18+ (ES modules) |
| Language | TypeScript 5, compiled to ESM |
| Protocol | MCP 1.x (JSON-RPC 2.0 over stdio) |
| Transport | `StdioServerTransport` from `@modelcontextprotocol/sdk` |
| QRadar API version | v20.0+ (QRadar 7.3+) |
| Auth method | QRadar authorized service token (SEC header) |

---

## 4. Configuration

All configuration is supplied via environment variables. The server reads them at startup and fails fast if required variables are missing.

| Variable | Required | Description |
|---|---|---|
| `QRADAR_URL` | Yes | Base URL of the QRadar console, e.g. `https://qradar.corp.com` |
| `QRADAR_API_TOKEN` | Yes | Authorized service token (SEC header value) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | Set to `0` to allow self-signed TLS (default behaviour). Set to `1` to enforce strict TLS. |
| `QRADAR_TIMEOUT_MS` | No | HTTP request timeout in milliseconds. Default: `30000`. |
| `QRADAR_POLL_INTERVAL_MS` | No | AQL search poll interval. Default: `1000`. |
| `QRADAR_MAX_POLL_ATTEMPTS` | No | Max poll attempts before timing out. Default: `60` (60 s at 1 s interval). |

---

## 5. Tool specification

Each tool is registered with the MCP server and exposed to the LLM client. Tools are defined with a name, description, Zod input schema, and async handler.

---

### 5.1 `run_aql_query`

**Description:** Execute an arbitrary AQL query against the QRadar Ariel database.

**When the LLM should call it:** When the user provides or requests a specific AQL query, or when no higher-level tool covers the required search.

**Input schema:**

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | Yes | A valid AQL query string |

**Behaviour:**

1. POST the query to `POST /api/ariel/searches?query_expression={query}`.
2. Poll `GET /api/ariel/searches/{search_id}` every `QRADAR_POLL_INTERVAL_MS` ms until `status` is `COMPLETED` or `ERROR`.
3. On `COMPLETED`, fetch `GET /api/ariel/searches/{search_id}/results`.
4. Return the full results object as a JSON string.

**Output:** JSON string containing the Ariel results payload (`{ events: [...] }` or `{ flows: [...] }`).

**Errors:**

| Condition | Behaviour |
|---|---|
| AQL syntax error | QRadar returns 422; propagate message to LLM |
| Search status `ERROR` | Throw with QRadar error description |
| Poll timeout | Throw `AQL search timed out after {n} attempts` |

---

### 5.2 `search_events`

**Description:** Convenience wrapper for common event log searches. Builds an AQL query from structured filters and executes it.

**Input schema:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `source_ip` | `string` | No | — | Filter by source IP address (exact match) |
| `destination_ip` | `string` | No | — | Filter by destination IP address (exact match) |
| `username` | `string` | No | — | Filter by username (exact match) |
| `event_name` | `string` | No | — | Filter by event name (ILIKE, partial match) |
| `last_minutes` | `number` | No | `60` | Time window in minutes (uses AQL `LAST N MINUTES`) |

**Generated AQL template:**

```sql
SELECT sourceip, destinationip, username, QIDNAME(qid) as event, starttime
FROM events
[WHERE <conditions joined with AND>]
LAST {last_minutes} MINUTES
```

**Output:** Same as `run_aql_query`.

---

### 5.3 `get_offenses`

**Description:** Retrieve QRadar offenses (correlated alerts), optionally filtered by status and magnitude.

**Input schema:**

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `"OPEN" \| "HIDDEN" \| "CLOSED"` | No | Filter by offense status |
| `min_magnitude` | `number` (1–10) | No | Return only offenses with magnitude ≥ this value |

**Behaviour:**

1. Build a QRadar filter expression from the supplied parameters.
2. GET `/api/siem/offenses` with `fields=id,description,magnitude,status,start_time,offense_source` and the filter.
3. Return the offense array as a JSON string.

**Output:** JSON array of offense objects.

---

### 5.4 `list_log_sources`

**Description:** Return all configured log sources (firewalls, servers, endpoint agents, etc.) registered in QRadar.

**Input schema:** None.

**Behaviour:** GET `/api/config/event_sources/log_source_management/log_sources`.

**Output:** JSON array of log source objects including `id`, `name`, `type_name`, `status`, `last_event_time`.

---

### 5.5 `search_assets`

**Description:** Query the QRadar asset model by IP address or hostname.

**Input schema:**

| Field | Type | Required | Description |
|---|---|---|---|
| `ip` | `string` | No | Filter by IP address |
| `hostname` | `string` | No | Filter by hostname (partial match) |

**Behaviour:** GET `/api/asset_model/assets` with a QRadar filter expression built from inputs.

**Output:** JSON array of asset objects.

---

## 6. QRadar REST API mapping

| Tool | Method | Endpoint |
|---|---|---|
| `run_aql_query` / `search_events` | POST | `/api/ariel/searches` |
| — (poll) | GET | `/api/ariel/searches/{id}` |
| — (results) | GET | `/api/ariel/searches/{id}/results` |
| `get_offenses` | GET | `/api/siem/offenses` |
| `list_log_sources` | GET | `/api/config/event_sources/log_source_management/log_sources` |
| `search_assets` | GET | `/api/asset_model/assets` |

All requests include:

```
SEC: <QRADAR_API_TOKEN>
Content-Type: application/json
Accept: application/json
Version: 20.0
```

---

## 7. Error handling

### 7.1 Startup errors

If `QRADAR_URL` or `QRADAR_API_TOKEN` are missing at startup, the server logs an error to stderr and exits with code 1. The MCP client will surface this as a connection failure.

### 7.2 Tool errors

Tool handler errors are caught and returned to the LLM as MCP error responses (not unhandled exceptions). The error message is passed through so the LLM can inform the user and potentially retry with different parameters.

### 7.3 HTTP errors

| HTTP status | Interpretation | Behaviour |
|---|---|---|
| 401 | Invalid or expired API token | Throw with message prompting token check |
| 403 | Insufficient permissions | Throw with required capability name |
| 404 | Resource not found | Throw with resource identifier |
| 409 | AQL search conflict | Retry once after 2 s |
| 422 | Invalid AQL | Throw with QRadar error body |
| 5xx | QRadar server error | Throw with status and body |
| Network timeout | Host unreachable | Throw with timeout value |

---

## 8. Security

### 8.1 Credential handling

- The API token is read from an environment variable and passed as an HTTP header. It is never logged or returned in tool output.
- The token must be generated as a QRadar **Authorized Service** with minimum required capabilities (see section 9).

### 8.2 TLS

- By default `NODE_TLS_REJECT_UNAUTHORIZED` is unset, allowing self-signed certificates (common in QRadar on-premises deployments).
- Production deployments should use a valid certificate and set `NODE_TLS_REJECT_UNAUTHORIZED=1`.

### 8.3 Input sanitisation

- All tool inputs are validated via Zod before use. Invalid inputs are rejected before any HTTP call is made.
- AQL passed to `run_aql_query` is forwarded as-is to QRadar. The LLM is responsible for generating safe AQL; QRadar itself enforces AQL syntax and read-only semantics (AQL cannot mutate data).
- String fields used in filter expressions (source_ip, username, etc.) are interpolated directly into AQL/filter strings. For `v1.0`, inputs are trusted (the tool is used internally). A future version should add parameterisation or escaping for multi-tenant deployments.

### 8.4 Network exposure

The MCP server opens no listening port. It communicates only via stdio with the parent MCP client process. Network egress is outbound-only to the configured QRadar host.

---

## 9. Required QRadar permissions

The Authorized Service token must have the following QRadar capabilities:

| Capability | Tools requiring it |
|---|---|
| `SIEM` | `get_offenses` |
| `Log Activity` | `run_aql_query`, `search_events` |
| `Network Activity` | `run_aql_query` (flows), future `search_flows` |
| `Assets` | `search_assets` |
| `Administrator` | `list_log_sources` |

To create a token: **QRadar Admin → Authorized Services → Add Authorized Service**.

---

## 10. File structure

```
qradar-mcp/
├── src/
│   ├── index.ts              # MCP server bootstrap & tool registration
│   ├── qradar.ts             # Axios client, AQL poll loop, helper functions
│   └── tools/
│       ├── events.ts         # search_events, run_aql_query handlers
│       ├── flows.ts          # search_flows (v1.1)
│       ├── offenses.ts       # get_offenses, get_offense_by_id handlers
│       └── assets.ts         # search_assets handler
├── dist/                     # Compiled output (gitignored)
├── .env.example              # Environment variable template
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
└── SPEC.md                   # This file
```

---

## 11. Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server and stdio transport |
| `axios` | HTTP client for QRadar REST API |
| `zod` | Runtime input validation for tool schemas |
| `dotenv` | Load `.env` file in development |
| `typescript` | Type checking and compilation |
| `tsx` | Dev-mode TypeScript execution without a build step |

---

## 12. Build & release

```bash
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm run dev          # tsx src/index.ts (no build, dev only)
```

**Versioning:** Semantic versioning (`MAJOR.MINOR.PATCH`). The `version` field in `package.json` and `McpServer` constructor must be kept in sync.

**Publishing:** The package is not published to npm. Distribution is via GitHub repository clone.

---

## 13. Roadmap (post v1.0)

| Version | Feature |
|---|---|
| v1.1 | `search_flows` tool (NetFlow/IPFIX via Ariel flows table) |
| v1.1 | `get_offense_by_id` and `get_offense_notes` tools |
| v1.2 | `search_reference_sets` tool |
| v1.2 | Input escaping / parameterisation for filter strings |
| v2.0 | Multi-instance support (multiple QRadar hosts via tool namespacing) |
| v2.0 | SSE transport option (in addition to stdio) for web-based MCP clients |

---

## 14. Glossary

| Term | Definition |
|---|---|
| AQL | Ariel Query Language — the SQL-like query language used by QRadar to search the Ariel database |
| Ariel | QRadar's internal time-series database storing events and flows |
| MCP | Model Context Protocol — open protocol for connecting LLMs to external tools and data sources |
| Offense | A QRadar correlated alert, generated by rules firing against events or flows |
| SEC header | The QRadar REST API authentication header containing the authorized service token |
| Tool | An MCP-registered function the LLM can invoke by name with typed parameters |
