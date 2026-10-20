// One vocabulary for both stores' subscription states.
//
//   active    paid and renewing
//   grace     a renewal payment failed; the store is retrying and access stays on
//   canceled  auto-renew is off; access lasts until expires_at
//   hold      the retry window ran out (Google account hold, Apple billing retry); no access
//   paused    Google's pause; no access
//   pending   bought with a slow payment method, not paid yet; no access
//   expired   over
//   revoked   refunded or revoked (Apple), or voided (Google); no access
//   superseded  Google: replaced by a newer purchase token (an upgrade or a resubscribe)

export type State = "active" | "grace" | "canceled" | "hold" | "paused" | "pending" | "expired" | "revoked" | "superseded";

/** States the daily reconcile stops re-checking. */
export const FINAL_STATES: readonly State[] = ["expired", "revoked", "superseded"];

// An "active" row whose period ended more than this long ago means the
// renewal was never heard about (notifications and the daily reconcile
// both failing), so it stops giving access rather than lasting forever.
const STALE_ACTIVE_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether a subscription in `state` gives access now. Grace is trusted as
 *  the store last reported it (a notification or the daily reconcile moves
 *  it on); active is too, within three days of its period's end; canceled
 *  lasts until its expiry. */
export function grantsAccess(state: State, expiresAt: number | null, now: number): boolean {
  if (state === "grace") return true;
  if (state === "active") return expiresAt === null || expiresAt + STALE_ACTIVE_MS > now;
  return state === "canceled" && expiresAt !== null && expiresAt > now;
}
