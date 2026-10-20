// A space's household entitlements with the payers' names, for a
// "Included with Sam's subscription" line (needs @sync/server).
//
//   const care = await spaceBilling(env, bill, spaceId, who.member);
//   // { ok: true, entitlements: { care: { active: true, paidBy: [{ id, name: "Sam's iPhone" }], expiresAt } } }
//
// The space checks the caller is a member, so only its members see who pays.

import { spaceStub, type SpacesEnv } from "@sync/server/spaces";

/** The part of billing() this uses. */
interface Entitlements {
  entitlement(spaceId: string): Promise<Record<string, { active: boolean; paidBy: string[]; expiresAt: number | null }>>;
}

export type SpaceBilling = Record<string, { active: boolean; paidBy: { id: string; name: string }[]; expiresAt: number | null }>;

export async function spaceBilling(
  env: Pick<SpacesEnv, "SPACES">,
  bill: Entitlements,
  spaceId: string,
  memberId: string,
): Promise<{ ok: true; entitlements: SpaceBilling } | { ok: false; error: string }> {
  const space = spaceStub(env, spaceId);
  if (!space) return { ok: false, error: "NOT_FOUND" };
  const info = await space.info(memberId);
  if (!info.ok) return { ok: false, error: info.error };
  const names = new Map(info.info.devices.map((m) => [m.id, m.name]));
  const out: SpaceBilling = {};
  for (const [key, e] of Object.entries(await bill.entitlement(spaceId))) {
    out[key] = { ...e, paidBy: e.paidBy.map((id) => ({ id, name: names.get(id) ?? "" })) };
  }
  return { ok: true, entitlements: out };
}
