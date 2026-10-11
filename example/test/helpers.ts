import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const ORIGIN = "http://localhost:8787";

export type Res<T = any> = { status: number; body: T; headers: Headers };

/** A phone or browser: keeps the bearer token its last sign-in handed back. */
export class Client {
  token: string | null = null;
  constructor(readonly name: string, readonly platform = "ios") {}

  async call<T = any>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const headers: Record<string, string> = { "X-Device-Name": this.name, "X-Device-Platform": this.platform };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await SELF.fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  /** First launch: an anonymous user (unattested, as on a simulator). */
  async signInAnonymously() {
    const res = await this.call("POST", "/v1/auth/sign-in/anonymous", {});
    return this.keep(res);
  }

  /** Sends a code to `email`, reads it from the dev outbox, signs in with it. */
  async signInWithEmail(email: string) {
    expect((await this.call("POST", "/v1/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    const otp = await latestCode(email);
    return this.keep(await this.call("POST", "/v1/auth/sign-in/email-otp", { email, otp }));
  }

  async me() {
    return (await this.call<{ user: string; device: string; spaces: { spaceId: string; name: string }[] }>("GET", "/v1/me/spaces")).body;
  }

  async createList(name: string) {
    const res = await this.call("POST", "/v1/spaces", { name, platform: this.platform });
    expect(res.status).toBe(200);
    return res.body as SpaceInfo;
  }

  async addItem(spaceId: string, id: string, name: string) {
    const res = await this.call("POST", `/v1/spaces/${spaceId}/docs/groceries`, {
      writes: [
        { d: id, f: "name", v: name },
        { d: id, f: "done", v: false },
      ],
    });
    expect(res.status).toBe(200);
  }

  async items(spaceId: string) {
    const res = await this.call<{ docs: { id: string; name: string; done: boolean }[] }>("GET", `/v1/spaces/${spaceId}/docs/groceries`);
    return res.status === 200 ? res.body.docs.map((d) => d.name) : res.status;
  }

  private keep(res: Res) {
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const token = res.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    this.token = token;
    return res.body.user as { id: string; email: string; isAnonymous?: boolean };
  }
}

export type SpaceInfo = {
  spaceId: string;
  name: string;
  code: string;
  owner: string;
  you: string;
  devices: { id: string; devices: { id: string; name: string; platform: string }[] }[];
};

/** The code the Worker "emailed": it writes to the outbox in waitUntil, so
 *  it can land just after the response. */
export async function latestCode(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const res = await SELF.fetch(`${ORIGIN}/dev/outbox?email=${encodeURIComponent(email)}`);
    const { code } = await res.json<{ code: string | null }>();
    if (code) return code;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no code sent to ${email}`);
}
