ALTER TABLE messages ADD COLUMN peer TEXT NOT NULL DEFAULT 'mika';
CREATE INDEX IF NOT EXISTS idx_msg_peer ON messages(user_email, peer, ts);
CREATE TABLE IF NOT EXISTS conversations (
  user_email TEXT NOT NULL,
  peer       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_email, peer)
);
