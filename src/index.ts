#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, QRadarClient } from "./qradar.js";
import {
  runAqlQuery,
  runAqlQuerySchema,
  searchEvents,
  searchEventsSchema,
} from "./tools/events.js";
import { getOffenses, getOffensesSchema } from "./tools/offenses.js";
import { searchAssets, searchAssetsSchema } from "./tools/assets.js";
import {
  listLogSources,
  listLogSourcesSchema,
} from "./tools/log_sources.js";

const SERVER_NAME = "qradar-mcp";
const SERVER_VERSION = "1.0.0";

/**
 * Wrap a tool handler so any thrown error is returned to the LLM as an MCP
 * error result (isError) rather than an unhandled exception.
 */
function safeHandler<A>(
  handler: (args: A) => Promise<{ content: { type: "text"; text: string }[] }>
) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: `Error: ${message}` }],
      };
    }
  };
}

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[qradar-mcp] fatal: ${message}\n`);
    process.exit(1);
  }

  const client = new QRadarClient(config);
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.tool(
    "run_aql_query",
    "Execute an arbitrary AQL (Ariel Query Language) query against the QRadar Ariel database. Use when the user provides or requests a specific AQL query, or when no higher-level tool covers the search.",
    runAqlQuerySchema,
    safeHandler((args) => runAqlQuery(client, args))
  );

  server.tool(
    "search_events",
    "Search QRadar event logs using structured filters (source IP, destination IP, username, event name, time window). Builds and runs an AQL query for you.",
    searchEventsSchema,
    safeHandler((args) => searchEvents(client, args))
  );

  server.tool(
    "get_offenses",
    "Retrieve QRadar offenses (correlated alerts), optionally filtered by status and minimum magnitude.",
    getOffensesSchema,
    safeHandler((args) => getOffenses(client, args))
  );

  server.tool(
    "list_log_sources",
    "List all configured QRadar log sources (firewalls, servers, endpoint agents, etc.) with their status and last event time.",
    listLogSourcesSchema,
    safeHandler(() => listLogSources(client))
  );

  server.tool(
    "search_assets",
    "Query the QRadar asset model by IP address or hostname.",
    searchAssetsSchema,
    safeHandler((args) => searchAssets(client, args))
  );

  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[qradar-mcp] fatal: ${message}\n`);
    process.exit(1);
  });

  process.stderr.write(
    `[qradar-mcp] v${SERVER_VERSION} started, connected to ${config.baseUrl}\n`
  );
}

main();
