-- What the test Worker's onLinkAccount saw.
CREATE TABLE IF NOT EXISTS test_links (anonymous_user_id TEXT NOT NULL, user_id TEXT NOT NULL);

-- What the test Worker's onDeleteAccount saw.
CREATE TABLE IF NOT EXISTS test_deletes (user_id TEXT NOT NULL, email TEXT NOT NULL, anonymous INTEGER NOT NULL);
