import { describe, expect, it } from "vitest";
import { checkQuery, runTelemetrySql, TelemetrySqlError } from "../src/telemetry-sql";

const env = { TELEMETRY_SQL_TOKEN: "tok", TELEMETRY_WAREHOUSE: "abc123_telemetry", TELEMETRY_APPS: '["glp3"]' };
const Q = "SELECT name, COUNT(*) n FROM telemetry.events WHERE app_id = 'glp3' AND __ingest_ts >= '2026-10-01' GROUP BY name";

describe("checkQuery", () => {
  it("accepts one SELECT or WITH statement, with a trailing semicolon", () => {
    expect(checkQuery(`${Q};`, ["glp3"])).toBe(Q);
    expect(checkQuery(`WITH x AS (${Q}) SELECT * FROM x`, ["glp3"])).toContain("WITH");
  });

  it("refuses writes and second statements, ignoring words inside strings", () => {
    expect(() => checkQuery("DROP TABLE telemetry.events")).toThrow(TelemetrySqlError);
    expect(() => checkQuery(`${Q}; DELETE FROM telemetry.events`)).toThrow("one statement only");
    expect(() => checkQuery("SELECT 1 FROM x WHERE a = 1 /* ; */ UNION SELECT 1; update y")).toThrow();
    expect(checkQuery("SELECT * FROM telemetry.events WHERE app_id = 'glp3' AND name = 'reminder_schedule_synced; update'", ["glp3"])).toContain("update");
    expect(checkQuery("SELECT COUNT(*) FROM telemetry.events WHERE app_id = 'glp3' AND name = 'onboarding_goals_set'", ["glp3"])).toBeTruthy();
  });

  it("keeps queries to the allowed apps", () => {
    expect(() => checkQuery("SELECT * FROM telemetry.events", ["glp3"])).toThrow("filter on app_id");
    expect(() => checkQuery("SELECT * FROM telemetry.events WHERE app_id = 'other'", ["glp3"])).toThrow("not readable");
    expect(() => checkQuery("SELECT * FROM telemetry.events WHERE app_id IN ('glp3', 'other')", ["glp3"])).toThrow("not readable");
    expect(checkQuery("SELECT * FROM telemetry.events WHERE app_id IN ('glp3')", ["glp3"])).toBeTruthy();
    expect(checkQuery("SELECT * FROM telemetry.events")).toBeTruthy();
  });
});

describe("runTelemetrySql", () => {
  it("posts to the warehouse's Basin SQL endpoint and returns rows", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ success: true, result: { rows: [{ name: "first_open", n: 3 }] } });
    }) as unknown as typeof fetch;
    const out = await runTelemetrySql(env, Q, fake);
    expect(out).toEqual({ rows: [{ name: "first_open", n: 3 }], truncated: false });
    expect(seen!.url).toBe("https://api.sql.cloudflarestorage.com/api/v1/accounts/abc123/basin-sql/query/telemetry");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ warehouse: "abc123_telemetry", query: Q });
  });

  it("reports Basin's error and refuses when not set up", async () => {
    const fake = (async () => Response.json({ success: false, errors: [{ message: "bad column" }] }, { status: 400 })) as unknown as typeof fetch;
    await expect(runTelemetrySql(env, Q, fake)).rejects.toThrow("Basin SQL: bad column");
    await expect(runTelemetrySql({}, Q, fake)).rejects.toThrow("not set up");
  });
});
