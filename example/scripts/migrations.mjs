// Every SQL file the example's D1 needs, in order: the sync server's, the
// auth and push packages', then the example's own.
export const MIGRATIONS = [
  "../server/migrations/space_codes.sql",
  "../server/migrations/space_members.sql",
  "../auth/migrations/attest.sql",
  "../auth/migrations/better_auth.sql",
  "../push/migrations/push_tokens.sql",
  "./migrations/dev_outbox.sql",
];
