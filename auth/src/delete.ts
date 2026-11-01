// flareDeleteAccount: `POST /delete-account`, which deletes the signed-in
// user. The App Store (guideline 5.1.1(v)) and Google Play require an app
// that lets people make an account to let them delete it from inside the
// app, so every app on @flare/auth gets this route.
//
// It's a soft delete with a grace period. The user goes into
// `deleted_accounts` and is signed out on every phone, and their data stays
// put for `deleteAfterDays` (30 by default): signing back in within it
// restores the account as it was. After that, `purgeDeletedAccounts` (run
// it daily from the Worker's cron) deletes what the app keeps in
// `onDeleteAccount`, then the user, their sign-in methods and sessions. An
// anonymous user can never sign back in, so theirs is purged straight away.
//
// Better Auth's own `/delete-user` stays off: it wants a password or a
// session made in the last day, and an anonymous user with a year-long
// session on a phone has neither. Holding the session is the proof here,
// as it is for everything else the app does.

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

/** The user being deleted, for the app to delete what it keeps about them. */
export type DeletedAccount = { userId: string; email: string; isAnonymous: boolean };

export type DeleteAccount = (account: DeletedAccount) => Promise<unknown>;

export const DEFAULT_DELETE_AFTER_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

type FlareUser = { id: string; email: string; isAnonymous?: boolean | null };

/** The bits of Better Auth's context the purge uses. */
export type Context = {
  internalAdapter: {
    findUserById(id: string): Promise<FlareUser | null>;
    deleteUser(id: string): Promise<void>;
    deleteUserSessions(id: string): Promise<void>;
  };
};

export interface FlareDeleteOptions {
  onDeleteAccount?: DeleteAccount;
  /** Days a deleted account can be restored by signing back in. 0 purges at once. */
  deleteAfterDays?: number;
}

export const flareDeleteAccount = (env: { DB: D1Database }, options: FlareDeleteOptions = {}) =>
  ({
    id: "flare-delete-account",
    endpoints: {
      deleteAccount: createAuthEndpoint(
        "/delete-account",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const user = ctx.context.session.user as typeof ctx.context.session.user & FlareUser;
          const context = ctx.context as unknown as Context;
          const days = options.deleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS;
          if (user.isAnonymous === true || days <= 0) {
            await purge(env, context, user, options.onDeleteAccount);
            deleteSessionCookie(ctx);
            return ctx.json({ deleted: true, restorableUntil: null });
          }
          const now = Date.now();
          await env.DB.prepare("INSERT OR IGNORE INTO deleted_accounts (user_id, deleted_at) VALUES (?, ?)").bind(user.id, now).run();
          await context.internalAdapter.deleteUserSessions(user.id);
          deleteSessionCookie(ctx);
          log("auth_account_deleted", user.id, { soft: true });
          return ctx.json({ deleted: true, restorableUntil: new Date(now + days * DAY_MS).toISOString() });
        },
      ),
    },
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                // Signing in to an account deleted within the grace period restores it.
                async after(session) {
                  const { meta } = await env.DB.prepare("DELETE FROM deleted_accounts WHERE user_id = ?").bind(session.userId).run();
                  if (meta.changes > 0) log("auth_account_restored", session.userId);
                },
              },
            },
          },
        },
      };
    },
  }) satisfies BetterAuthPlugin;

/** Purges every account whose grace period is over. One that fails stays
 *  for the next run. */
export async function purgeExpired(env: { DB: D1Database }, context: Context, options: FlareDeleteOptions, now = Date.now()) {
  const days = options.deleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS;
  const { results } = await env.DB.prepare("SELECT user_id FROM deleted_accounts WHERE deleted_at < ? ORDER BY deleted_at LIMIT 500")
    .bind(now - days * DAY_MS)
    .all<{ user_id: string }>();
  let purged = 0;
  let failed = 0;
  for (const { user_id } of results) {
    try {
      await purgeOne(env, context, user_id, options);
      purged++;
    } catch {
      failed++;
    }
  }
  return { purged, failed };
}

/** Deletes one user for good now, deleted or not: for someone who asks by
 *  email instead of waiting out the grace period. False when there's no such user. */
export async function purgeOne(env: { DB: D1Database }, context: Context, userId: string, options: FlareDeleteOptions) {
  const user = await context.internalAdapter.findUserById(userId);
  if (!user) {
    await env.DB.prepare("DELETE FROM deleted_accounts WHERE user_id = ?").bind(userId).run();
    return false;
  }
  await purge(env, context, user, options.onDeleteAccount);
  return true;
}

/** The app's data first; if that throws, nothing else goes, so it can be tried again. */
async function purge(env: { DB: D1Database }, context: Context, user: FlareUser, onDeleteAccount?: DeleteAccount) {
  const account: DeletedAccount = { userId: user.id, email: user.email, isAnonymous: user.isAnonymous === true };
  try {
    await onDeleteAccount?.(account);
  } catch (error) {
    console.error(JSON.stringify({ event: "auth_account_delete_failed", user: user.id.slice(0, 8), error: String(error) }));
    throw new APIError("INTERNAL_SERVER_ERROR", { code: "DELETE_FAILED", message: "Couldn't delete the account. Try again." });
  }
  await context.internalAdapter.deleteUser(user.id);
  await context.internalAdapter.deleteUserSessions(user.id);
  await env.DB.prepare("DELETE FROM deleted_accounts WHERE user_id = ?").bind(user.id).run();
  log("auth_account_deleted", user.id, { soft: false, anonymous: account.isAnonymous });
}

function log(event: string, userId: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, user: userId.slice(0, 8), ...extra }));
}
