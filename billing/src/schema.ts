// billing.json: which store products unlock which entitlement, and whether
// one payer unlocks it for their whole space (household).
//
//   { "entitlements": { "care": { "products": ["com.example.care.yearly"], "household": true } } }

export interface Entitlement {
  /** App Store and Play product ids (subscription ids on Play). */
  products: string[];
  /** One paying member unlocks it for everyone in each space they're in. */
  household?: boolean;
}

export interface BillingFile {
  entitlements: Record<string, Entitlement>;
}

export type EntitlementKey<F extends BillingFile> = Extract<keyof F["entitlements"], string>;

/** Problems with a billing.json, or none. */
export function checkBilling(file: unknown): string[] {
  const problems: string[] = [];
  const entitlements = (file as BillingFile | null)?.entitlements;
  if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) return ['needs an "entitlements" object'];
  if (Object.keys(entitlements).length === 0) problems.push("has no entitlements");
  for (const [key, e] of Object.entries(entitlements)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) problems.push(`entitlement "${key}" should be snake_case`);
    if (!Array.isArray(e?.products) || e.products.length === 0) problems.push(`entitlement "${key}" needs products`);
    else if (e.products.some((p) => typeof p !== "string" || p.length === 0)) problems.push(`entitlement "${key}" has a product that isn't an id`);
    if (e?.household !== undefined && typeof e.household !== "boolean") problems.push(`entitlement "${key}": household is true or false`);
  }
  return problems;
}

/** The entitlements a product unlocks. */
export function entitlementsOf(file: BillingFile, productId: string): string[] {
  return Object.entries(file.entitlements)
    .filter(([, e]) => e.products.includes(productId))
    .map(([key]) => key);
}
