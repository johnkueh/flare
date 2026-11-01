-- Soft-deleted accounts (POST /delete-account): when the user deleted it.
-- Signing back in clears it; purgeDeletedAccounts deletes the user once
-- it's older than deleteAfterDays. Apply after better_auth.sql.
ALTER TABLE "user" ADD COLUMN "deletedAt" date;
