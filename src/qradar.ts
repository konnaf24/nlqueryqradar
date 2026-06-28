import axios, { AxiosInstance, AxiosError } from "axios";

/**
 * Configuration resolved from environment variables at startup.
 */
export interface QRadarConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  pollIntervalMs: number;
  maxPollAttempts: number;
}

const QRADAR_API_VERSION = "20.0";

/**
 * Read and validate configuration from the environment. Fails fast (throws)
 * when a required variable is missing.
 */
export function loadConfig(): QRadarConfig {
  const baseUrl = process.env.QRADAR_URL;
  const apiToken = process.env.QRADAR_API_TOKEN;

  if (!baseUrl) {
    throw new Error("QRADAR_URL environment variable is required");
  }
  if (!apiToken) {
    throw new Error("QRADAR_API_TOKEN environment variable is required");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiToken,
    timeoutMs: parseIntEnv("QRADAR_TIMEOUT_MS", 30000),
    pollIntervalMs: parseIntEnv("QRADAR_POLL_INTERVAL_MS", 1000),
    maxPollAttempts: parseIntEnv("QRADAR_MAX_POLL_ATTEMPTS", 60),
  };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin client over the QRadar REST API. Stateless: every call issues a fresh
 * HTTPS request. Handles auth headers, error normalisation, and the Ariel
 * search poll loop.
 */
export class QRadarClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: QRadarConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      headers: {
        SEC: config.apiToken,
        "Content-Type": "application/json",
        Accept: "application/json",
        Version: QRADAR_API_VERSION,
      },
    });
  }

  /**
   * Execute an AQL query end-to-end: create the Ariel search, poll until it
   * completes, then fetch and return the results payload.
   */
  async runAql(query: string): Promise<unknown> {
    const search = await this.createSearch(query);
    const searchId: string = search.search_id ?? search.id;
    if (!searchId) {
      throw new Error("QRadar did not return a search_id for the AQL query");
    }

    const completed = await this.pollSearch(searchId);
    if (completed.status === "ERROR") {
      const description =
        completed.error_messages?.map((m: any) => m.message).join("; ") ??
        completed.status_message ??
        "unknown error";
      throw new Error(`AQL search failed: ${description}`);
    }

    return this.getResults(searchId);
  }

  private async createSearch(query: string): Promise<any> {
    const exec = async () =>
      (
        await this.http.post("/api/ariel/searches", null, {
          params: { query_expression: query },
        })
      ).data;

    try {
      return await exec();
    } catch (err) {
      // 409: AQL search conflict — retry once after 2s.
      if (err instanceof AxiosError && err.response?.status === 409) {
        await sleep(2000);
        return exec();
      }
      throw this.normaliseError(err, "create AQL search");
    }
  }

  private async pollSearch(searchId: string): Promise<any> {
    for (let attempt = 1; attempt <= this.config.maxPollAttempts; attempt++) {
      let data: any;
      try {
        data = (
          await this.http.get(
            `/api/ariel/searches/${encodeURIComponent(searchId)}`
          )
        ).data;
      } catch (err) {
        throw this.normaliseError(err, "poll AQL search");
      }

      if (data.status === "COMPLETED" || data.status === "ERROR") {
        return data;
      }

      await sleep(this.config.pollIntervalMs);
    }

    throw new Error(
      `AQL search timed out after ${this.config.maxPollAttempts} attempts`
    );
  }

  private async getResults(searchId: string): Promise<unknown> {
    try {
      return (
        await this.http.get(
          `/api/ariel/searches/${encodeURIComponent(searchId)}/results`
        )
      ).data;
    } catch (err) {
      throw this.normaliseError(err, "fetch AQL results");
    }
  }

  /**
   * Issue a GET against an arbitrary QRadar REST path, applying an optional
   * QRadar `filter` expression and `fields` projection.
   */
  async get(
    path: string,
    options: { filter?: string; fields?: string } = {}
  ): Promise<unknown> {
    const params: Record<string, string> = {};
    if (options.filter) params.filter = options.filter;
    if (options.fields) params.fields = options.fields;

    try {
      return (await this.http.get(path, { params })).data;
    } catch (err) {
      throw this.normaliseError(err, `GET ${path}`);
    }
  }

  /**
   * Convert an axios error into a descriptive Error with QRadar context,
   * following the HTTP status mapping defined in the spec.
   */
  private normaliseError(err: unknown, context: string): Error {
    if (err instanceof AxiosError) {
      if (err.response) {
        const status = err.response.status;
        const body =
          typeof err.response.data === "string"
            ? err.response.data
            : JSON.stringify(err.response.data);

        switch (status) {
          case 401:
            return new Error(
              `${context}: 401 Unauthorized — check QRADAR_API_TOKEN is valid and not expired. ${body}`
            );
          case 403:
            return new Error(
              `${context}: 403 Forbidden — the authorized service token lacks the required QRadar capability. ${body}`
            );
          case 404:
            return new Error(`${context}: 404 Not Found — ${body}`);
          case 422:
            return new Error(`${context}: 422 Invalid request — ${body}`);
          default:
            return new Error(`${context}: HTTP ${status} — ${body}`);
        }
      }

      if (err.code === "ECONNABORTED") {
        return new Error(
          `${context}: request timed out after ${this.config.timeoutMs}ms — QRadar host may be unreachable`
        );
      }

      return new Error(
        `${context}: network error (${err.code ?? "unknown"}) — ${err.message}`
      );
    }

    return err instanceof Error ? err : new Error(`${context}: ${String(err)}`);
  }
}
