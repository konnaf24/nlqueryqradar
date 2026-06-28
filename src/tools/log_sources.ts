import { QRadarClient } from "../qradar.js";
import { jsonResult } from "./events.js";

// ---------------------------------------------------------------------------
// list_log_sources
// ---------------------------------------------------------------------------

export const listLogSourcesSchema = {};

export async function listLogSources(client: QRadarClient) {
  const data = await client.get(
    "/api/config/event_sources/log_source_management/log_sources",
    {
      fields: "id,name,type_name,status,last_event_time",
    }
  );
  return jsonResult(data);
}
