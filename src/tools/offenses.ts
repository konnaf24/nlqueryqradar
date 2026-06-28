import { z } from "zod";
import { QRadarClient } from "../qradar.js";
import { jsonResult } from "./events.js";

// ---------------------------------------------------------------------------
// get_offenses
// ---------------------------------------------------------------------------

export const getOffensesSchema = {
  status: z
    .enum(["OPEN", "HIDDEN", "CLOSED"])
    .optional()
    .describe("Filter by offense status"),
  min_magnitude: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Return only offenses with magnitude >= this value (1-10)"),
};

interface GetOffensesArgs {
  status?: "OPEN" | "HIDDEN" | "CLOSED";
  min_magnitude?: number;
}

/**
 * Build the QRadar `filter` expression for the offenses endpoint.
 * Returns undefined when no filters are supplied. Exported for testing.
 */
export function buildOffensesFilter(args: GetOffensesArgs): string | undefined {
  const parts: string[] = [];
  if (args.status) {
    parts.push(`status = "${args.status}"`);
  }
  if (args.min_magnitude !== undefined) {
    parts.push(`magnitude >= ${args.min_magnitude}`);
  }
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

export async function getOffenses(
  client: QRadarClient,
  args: GetOffensesArgs
) {
  const filter = buildOffensesFilter(args);
  const data = await client.get("/api/siem/offenses", {
    fields: "id,description,magnitude,status,start_time,offense_source",
    filter,
  });
  return jsonResult(data);
}
