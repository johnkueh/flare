// Read-only SQL over the telemetry table (TELEMETRY.md), for Claude and for artifacts that
// declare this connector: a dashboard can read `telemetry.events` live, the way it reads any
// other warehouse through its connector.
//
// The tool is only listed when TELEMETRY_SQL_TOKEN and TELEMETRY_WAREHOUSE are set. Basin SQL
// itself only reads; the token should be one that can read the telemetry catalog and nothing
// else. Queries are limited to one SELECT (or WITH … SELECT) statement.

export type TelemetrySqlEnv = {
  /** Secret: a Cloudflare API token that can read the telemetry catalog (Basin SQL). */
  TELEMETRY_SQL_TOKEN?: string;
  /** Your Basin warehouse, `<account id>_telemetry` (TELEMETRY.md, "Querying"). */
  TELEMETRY_WAREHOUSE?: string;
  /** Optional, JSON array: the only app ids a query may name in `app_id = '…'`, e.g. ["glp3"]. */
  TELEMETRY_APPS?: string;
};

export const MAX_ROWS = 10_000;
const MAX_SQL_CHARS = 20_000;

export class TelemetrySqlError extends Error {}

export const telemetrySqlEnabled = (env: TelemetrySqlEnv) => !!env.TELEMETRY_SQL_TOKEN && !!env.TELEMETRY_WAREHOUSE;

/** Text with string literals and comments blanked out, so keyword checks don't see inside them. */
function code(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Throws unless `sql` is one read-only statement over the telemetry table. Returns it trimmed. */
export function checkQuery(sql: unknown, allowedApps?: string[]): string {
  if (typeof sql !== "string" || !sql.trim()) throw new TelemetrySqlError("sql is required");
  const query = sql.trim().replace(/;\s*$/, "");
  if (query.length > MAX_SQL_CHARS) throw new TelemetrySqlError(`sql is longer than ${MAX_SQL_CHARS} characters`);
  const bare = code(query);
  if (bare.includes(";")) throw new TelemetrySqlError("one statement only");
  if (!/^\s*(select|with)\b/i.test(bare)) throw new TelemetrySqlError("only SELECT queries");
  if (/\b(insert|update|delete|merge|create|alter|drop|truncate|copy|grant|call|set)\b/i.test(bare))
    throw new TelemetrySqlError("only SELECT queries");
  if (allowedApps?.length) {
    const named = [
      ...[...query.matchAll(/\bapp_id\s*=\s*'([^']*)'/gi)].map((m) => m[1]),
      ...[...query.matchAll(/\bapp_id\s+in\s*\(([^)]*)\)/gi)].flatMap((m) => [...m[1].matchAll(/'([^']*)'/g)].map((v) => v[1])),
    ];
    if (named.length === 0) throw new TelemetrySqlError(`filter on app_id (one of ${allowedApps.join(", ")})`);
    const other = named.find((a) => !allowedApps.includes(a));
    if (other !== undefined) throw new TelemetrySqlError(`app_id '${other}' is not readable here`);
  }
  return query;
}

function allowedApps(env: TelemetrySqlEnv): string[] | undefined {
  if (!env.TELEMETRY_APPS) return undefined;
  try {
    const list = JSON.parse(env.TELEMETRY_APPS);
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : undefined;
  } catch {
    throw new TelemetrySqlError("TELEMETRY_APPS is not a JSON array");
  }
}

export type QueryResult = { rows: Record<string, unknown>[]; truncated: boolean };

/** Runs one checked query against Basin SQL. `fetcher` is for tests. */
export async function runTelemetrySql(env: TelemetrySqlEnv, sql: unknown, fetcher: typeof fetch = fetch): Promise<QueryResult> {
  if (!telemetrySqlEnabled(env)) throw new TelemetrySqlError("telemetry SQL is not set up on this server");
  const query = checkQuery(sql, allowedApps(env));
  const warehouse = env.TELEMETRY_WAREHOUSE as string;
  const split = warehouse.indexOf("_");
  if (split < 1) throw new TelemetrySqlError("TELEMETRY_WAREHOUSE should be <account id>_<bucket>");
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${warehouse.slice(0, split)}/basin-sql/query/${warehouse.slice(split + 1)}`;
  const response = await fetcher(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TELEMETRY_SQL_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse, query }),
  });
  const body = (await response.json().catch(() => null)) as { success?: boolean; errors?: { message: string }[]; result?: { rows?: Record<string, unknown>[] } } | null;
  if (!body?.success) {
    const why = body?.errors?.map((e) => e.message).join("; ") || `${response.status} ${response.statusText}`;
    throw new TelemetrySqlError(`Basin SQL: ${why}`);
  }
  const rows = body.result?.rows ?? [];
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}
