/** What attestation reads from the Worker's env. */
export interface AttestEnv {
  /** D1 with migrations/attest.sql applied. */
  DB: D1Database;
  /** "<team id>.<bundle id>" of apps whose App Attest keys are accepted, comma-separated. */
  APP_ATTEST_APP_IDS?: string;
  /** "true" accepts development keys (Xcode builds, debug Android builds). */
  APP_ATTEST_ALLOW_DEVELOPMENT?: string;
  /** Android package names whose Keystore attestations are accepted, comma-separated. */
  ANDROID_APP_IDS?: string;
  /** Lowercase hex SHA-256 of accepted Android signing certificates; empty accepts any. */
  ANDROID_CERT_DIGESTS?: string;
  /** Tests only: a root to trust instead of Apple's. */
  APP_ATTEST_TEST_ROOT_PEM?: string;
  /** Tests only: a root to trust instead of Google's. */
  ANDROID_ATTEST_TEST_ROOT_PEM?: string;
}
