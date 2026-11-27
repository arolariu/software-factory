CREATE TABLE management_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  host TEXT NOT NULL,
  subject TEXT NOT NULL,
  registration_id TEXT NOT NULL
);

CREATE TABLE management_pairing (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  digest TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE management_claims (
  session_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE management_pair_attempts (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
