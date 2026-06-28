import { z } from "zod";
import { QRadarClient } from "../qradar.js";
import { jsonResult } from "./events.js";

// ---------------------------------------------------------------------------
// search_assets
// ---------------------------------------------------------------------------

export const searchAssetsSchema = {
  ip: z.string().optional().describe("Filter by IP address"),
  hostname: z
    .string()
    .optional()
    .describe("Filter by hostname (partial match)"),
};

interface SearchAssetsArgs {
  ip?: string;
  hostname?: string;
}

/**
 * Build the QRadar `filter` expression for the asset model endpoint.
 * Returns undefined when no filters are supplied. Exported for testing.
 */
export function buildAssetsFilter(args: SearchAssetsArgs): string | undefined {
  const parts: string[] = [];
  if (args.ip) {
    parts.push(`interfaces contains (ip_addresses contains (value = "${args.ip}"))`);
  }
  if (args.hostname) {
    parts.push(`hostnames contains (name ILIKE "%${args.hostname}%")`);
  }
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

export async function searchAssets(
  client: QRadarClient,
  args: SearchAssetsArgs
) {
  const filter = buildAssetsFilter(args);
  const data = await client.get("/api/asset_model/assets", { filter });
  return jsonResult(data);
}
