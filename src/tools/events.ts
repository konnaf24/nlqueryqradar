import { z } from "zod";
import { QRadarClient } from "../qradar.js";

/**
 * Format an arbitrary payload as an MCP text content result.
 */
export function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// run_aql_query
// ---------------------------------------------------------------------------

export const runAqlQuerySchema = {
  query: z.string().min(1).describe("A valid AQL (Ariel Query Language) query string"),
};

export async function runAqlQuery(
  client: QRadarClient,
  args: { query: string }
) {
  const results = await client.runAql(args.query);
  return jsonResult(results);
}

// ---------------------------------------------------------------------------
// search_events
// ---------------------------------------------------------------------------

export const searchEventsSchema = {
  source_ip: z
    .string()
    .optional()
    .describe("Filter by source IP address (exact match)"),
  destination_ip: z
    .string()
    .optional()
    .describe("Filter by destination IP address (exact match)"),
  username: z
    .string()
    .optional()
    .describe("Filter by username (exact match)"),
  event_name: z
    .string()
    .optional()
    .describe("Filter by event name (partial, case-insensitive match)"),
  last_minutes: z
    .number()
    .int()
    .positive()
    .default(60)
    .describe("Time window in minutes (AQL LAST N MINUTES). Default 60."),
};

interface SearchEventsArgs {
  source_ip?: string;
  destination_ip?: string;
  username?: string;
  event_name?: string;
  last_minutes?: number;
}

/**
 * Build the AQL query for search_events from structured filters.
 * Exported for unit testing of the query-building logic.
 */
export function buildEventsQuery(args: SearchEventsArgs): string {
  const lastMinutes = args.last_minutes ?? 60;
  const conditions: string[] = [];

  if (args.source_ip) {
    conditions.push(`sourceip = '${args.source_ip}'`);
  }
  if (args.destination_ip) {
    conditions.push(`destinationip = '${args.destination_ip}'`);
  }
  if (args.username) {
    conditions.push(`username = '${args.username}'`);
  }
  if (args.event_name) {
    conditions.push(`QIDNAME(qid) ILIKE '%${args.event_name}%'`);
  }

  const where =
    conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  return (
    "SELECT sourceip, destinationip, username, QIDNAME(qid) as event, starttime " +
    `FROM events${where} LAST ${lastMinutes} MINUTES`
  );
}

export async function searchEvents(
  client: QRadarClient,
  args: SearchEventsArgs
) {
  const query = buildEventsQuery(args);
  const results = await client.runAql(query);
  return jsonResult(results);
}
