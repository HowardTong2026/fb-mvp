-- Facebook Clone — full social schema

CREATE TABLE IF NOT EXISTS profiles (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  bio         TEXT,
  color       TEXT,
  is_npc      INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,
  author_email TEXT NOT NULL,
  body         TEXT NOT NULL,
  edited_at    INTEGER,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_ts ON posts(ts DESC);

CREATE TABLE IF NOT EXISTS likes (
  post_id    TEXT NOT NULL,
  user_email TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_email)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL,
  user_email TEXT NOT NULL,
  body       TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, ts);

CREATE TABLE IF NOT EXISTS friends (
  owner_email  TEXT NOT NULL,
  friend_email TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  PRIMARY KEY (owner_email, friend_email)
);

-- friend requests: 'pending' | 'accepted' | 'declined'
CREATE TABLE IF NOT EXISTS friend_requests (
  from_email TEXT NOT NULL,
  to_email   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  ts         INTEGER NOT NULL,
  PRIMARY KEY (from_email, to_email)
);
CREATE INDEX IF NOT EXISTS idx_freq_to ON friend_requests(to_email, status);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  from_email TEXT,
  from_name  TEXT,
  kind       TEXT NOT NULL,
  post_id    TEXT,
  text       TEXT,
  ts         INTEGER NOT NULL,
  read       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_email, ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  user_email       TEXT PRIMARY KEY,
  notify_likes     INTEGER DEFAULT 1,
  notify_comments  INTEGER DEFAULT 1,
  notify_friends   INTEGER DEFAULT 1,
  updated_at       INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  role       TEXT NOT NULL,
  from_name  TEXT,
  body       TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_user_ts ON messages(user_email, ts);

CREATE TABLE IF NOT EXISTS chat_sessions (
  user_email TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
