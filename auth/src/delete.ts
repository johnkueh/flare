// flareDeleteAccount: `POST /delete-account`, which deletes the signed-in
// user. The App Store (guideline 5.1.1(v)) and Google Play require an app
// that lets people make an account to let them delete it from inside the
// app, so every app on @flare/auth gets this route.
//
// It's a soft delete with a grace period. The user is marked deleted and
// signed out on every phone, and their data stays put for `deleteAfterDays`
// (30 by default): signing back in within it restores the account as it
// was. After that, `purgeDeletedAccounts` (run it daily from the Worker's
// cron) deletes what the app keeps in `onDeleteAccount`, then the user,
// their sign-in methods and sessions. An anonymous user can never sign back
// in, so theirs is deleted straight away.
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

type FlareUser = { id: string; email: string; isAnonymous?: boolean | null; deletedAt?: Date | string | null };

/** The bits of Better Auth's context the delete and the purge use. */
type Context = {
  adapter: {
    findMany<T>(args: { model: string; where: { field: string; value: unknown; operator?: "lt" | "ne" }[]; limit?: number }): Promise<T[]>;
  };
  internalAdapter: {
    updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
    deleteUser(id: string): Promise<void>;
    deleteUserSessions(id: string): Promise<void>;
  };
};

export interface FlareDeleteOptions {
  onDeleteAccount?: DeleteAccount;
  /** Days a deleted account can be restored by signing back in. 0 deletes at once. */
  deleteAfterDays?: number;
}

export const flareDeleteAccount = (options: FlareDeleteOptions = {}) =>
  ({
    id: "flare-delete-account",
    schema: {
      user: {
        fields: {
          // Set by /delete-account; cleared by signing back in. Null for everyone else.
          deletedAt: { type: "date", required: false, input: false },
        },
      },
    },
    endpoints: {
      deleteAccount: createAuthEndpoint(
        "/delete-account",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const user = ctx.context.session.user as typeof ctx.context.session.user & FlareUser;
          const context = ctx.context as unknown as Context;
          const days = options.deleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS;
          if (user.isAnonymous === true || days <= 0) {
            await purge(context, user, options.onDeleteAccount);
            deleteSessionCookie(ctx);
            return ctx.json({ deleted: true, restorableUntil: null });
          }
          const now = new Date();
          await context.internalAdapter.updateUser(user.id, { deletedAt: now });
          await context.internalAdapter.deleteUserSessions(user.id);
          deleteSessionCookie(ctx);
          log("auth_account_deleted", user, { soft: true });
          return ctx.json({ deleted: true, restorableUntil: new Date(now.getTime() + days * DAY_MS).toISOString() });
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
                async after(session, ctx) {
                  const context = ctx?.context as unknown as Context | undefined;
                  if (!context) return;
                  const [user] = await context.adapter.findMany<FlareUser>({
                    model: "user",
                    where: [{ field: "id", value: session.userId }],
                    limit: 1,
                  });
                  if (!user?.deletedAt) return;
                  await context.internalAdapter.updateUser(user.id, { deletedAt: null });
                  log("auth_account_restored", user);
                },
              },
            },
          },
        },
      };
    },
  }) satisfies BetterAuthPlugin;

/** Deletes every account whose grace period is over: the app's data
 *  (`onDeleteAccount`), then the user. One that fails is left for the next
 *  run. Returns how many went and how many failed. */
export async function purgeExpired(context: Context, options: FlareDeleteOptions, now = Date.now()) {
  const days = options.deleteAfterDays ?? DEFAULT_DELETE_AFTER_DAYS;
  const due = await context.adapter.findMany<FlareUser>({
    model: "user",
    where: [{ field: "deletedAt", value: new Date(now - days * DAY_MS), operator: "lt" }],
    limit: 500,
  });
  let purged = 0;
  let failed = 0;
  for (const user of due) {
    try {
      await purge(context, user, options.onDeleteAccount);
      purged++;
    } catch {
      failed++;
    }
  }
  return { purged, failed };
}

/** Deletes one user for good now, deleted or not: for someone who asks by
 *  email instead of waiting out the grace period. False when there's no such user. */
export async function purgeOne(context: Context, userId: string, options: FlareDeleteOptions) {
  const [user] = await context.adapter.findMany<FlareUser>({ model: "user", where: [{ field: "id", value: userId }], limit: 1 });
  if (!user) return false;
  await purge(context, user, options.onDeleteAccount);
  return true;
}

/** The app's data first; if that throws, nothing else goes, so it can be tried again. */
async function purge(context: Context, user: FlareUser, onDeleteAccount?: DeleteAccount) {
  const account: DeletedAccount = { userId: user.id, email: user.email, isAnonymous: user.isAnonymous === true };
  try {
    await onDeleteAccount?.(account);
  } catch (error) {
    console.error(JSON.stringify({ event: "auth_account_delete_failed", user: user.id.slice(0, 8), error: String(error) }));
    throw new APIError("INTERNAL_SERVER_ERROR", { code: "DELETE_FAILED", message: "Couldn't delete the account. Try again." });
  }
  await context.internalAdapter.deleteUser(user.id);
  await context.internalAdapter.deleteUserSessions(user.id);
  log("auth_account_deleted", user, { soft: false });
}

function log(event: string, user: FlareUser, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, user: user.id.slice(0, 8), anonymous: user.isAnonymous === true, ...extra }));
}
