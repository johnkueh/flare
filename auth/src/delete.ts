// flareDeleteAccount: `POST /delete-account`, which deletes the signed-in
// user. The App Store (guideline 5.1.1(v)) and Google Play require an app
// that lets people make an account to let them delete it from inside the
// app, so every app on @flare/auth gets this route.
//
// The app's own data goes first, in `onDeleteAccount` (leave its spaces,
// forget its push tokens, drop its rows); then the user, their sign-in
// methods and every session, on every phone. If the app's part throws,
// nothing is deleted and the phone can try again.
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

export const flareDeleteAccount = (onDeleteAccount?: DeleteAccount) =>
  ({
    id: "flare-delete-account",
    endpoints: {
      deleteAccount: createAuthEndpoint(
        "/delete-account",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const user = ctx.context.session.user as typeof ctx.context.session.user & { isAnonymous?: boolean | null };
          const account: DeletedAccount = { userId: user.id, email: user.email, isAnonymous: user.isAnonymous === true };
          try {
            await onDeleteAccount?.(account);
          } catch (error) {
            console.error(JSON.stringify({ event: "auth_account_delete_failed", user: user.id.slice(0, 8), error: String(error) }));
            throw new APIError("INTERNAL_SERVER_ERROR", { code: "DELETE_FAILED", message: "Couldn't delete the account. Try again." });
          }
          await ctx.context.internalAdapter.deleteUser(user.id);
          await ctx.context.internalAdapter.deleteUserSessions(user.id);
          deleteSessionCookie(ctx);
          console.log(JSON.stringify({ event: "auth_account_deleted", user: user.id.slice(0, 8), anonymous: account.isAnonymous }));
          return ctx.json({ deleted: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
