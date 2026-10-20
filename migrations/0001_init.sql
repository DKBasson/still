CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  accountStatus TEXT NOT NULL DEFAULT 'pending' CHECK (accountStatus IN ('pending', 'approved', 'rejected', 'suspended', 'banned')),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  bio TEXT NOT NULL DEFAULT '',
  avatarKey TEXT,
  statusReason TEXT,
  suspendedUntil TEXT
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX session_userId ON session (userId);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE (providerId, accountId)
);

CREATE INDEX account_userId ON account (userId);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX verification_identifier ON verification (identifier);

CREATE TABLE rateLimit (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  lastRequest INTEGER NOT NULL
);

CREATE TABLE follows (
  followerId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  followeeId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (followerId, followeeId),
  CHECK (followerId <> followeeId)
);

CREATE INDEX follows_followee ON follows (followeeId, followerId);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  authorId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  imageKey TEXT NOT NULL UNIQUE,
  contentType TEXT NOT NULL,
  byteSize INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  removedAt TEXT,
  removedBy TEXT,
  removalReason TEXT,
  removalKind TEXT CHECK (removalKind IN ('user', 'moderation') OR removalKind IS NULL)
);

CREATE INDEX posts_author_created ON posts (authorId, createdAt DESC, id DESC);
CREATE INDEX posts_created ON posts (createdAt DESC, id DESC);

CREATE TABLE likes (
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  postId TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (userId, postId)
);

CREATE INDEX likes_post ON likes (postId);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporterId TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  targetType TEXT NOT NULL CHECK (targetType IN ('post', 'account')),
  targetPostId TEXT REFERENCES posts(id) ON DELETE SET NULL,
  targetUserId TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN ('harassment', 'inappropriate', 'spam', 'copyright', 'other')),
  explanation TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'resolved', 'dismissed')),
  assignedTo TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  resolutionReason TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  resolvedAt TEXT
);

CREATE INDEX reports_status_created ON reports (status, createdAt DESC);
CREATE INDEX reports_target_post ON reports (targetPostId, status);
CREATE INDEX reports_target_user ON reports (targetUserId, status);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actorId TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  actorLabel TEXT NOT NULL,
  action TEXT NOT NULL,
  targetType TEXT NOT NULL,
  targetId TEXT NOT NULL,
  reason TEXT,
  createdAt TEXT NOT NULL
);

CREATE INDEX audit_log_created ON audit_log (createdAt DESC);
CREATE INDEX audit_log_actor ON audit_log (actorId, createdAt DESC);

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TABLE dev_mailbox (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX dev_mailbox_recipient ON dev_mailbox (recipient, createdAt DESC);

CREATE TABLE app_rate_limit (
  key TEXT NOT NULL,
  windowStart INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, windowStart)
);
