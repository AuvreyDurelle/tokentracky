-- Profile extras: a verified GitHub login, achievements computed from published data (F7) and likes.
-- Badges read the account projection from 0012 (copies across computers count once).
ALTER TABLE cloud_accounts ADD COLUMN github_login text CHECK (github_login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$');
-- Podium: the best all-time rank ever reached. Lower is better; null until ranked.
ALTER TABLE cloud_publications ADD COLUMN best_rank integer CHECK (best_rank >= 1);
-- Precomputed on upload, so public reads never compute badges.
CREATE TABLE cloud_badges (
  account_id text REFERENCES cloud_publications(account_id) ON DELETE CASCADE,
  badge text CHECK (badge ~ '^[a-z-]{1,32}$'),
  tier smallint NOT NULL CHECK (tier BETWEEN 0 AND 4),
  value bigint NOT NULL CHECK (value BETWEEN 0 AND 9007199254740991),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, badge)
);
CREATE TABLE cloud_likes (
  liker_id text REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  target_id text REFERENCES cloud_publications(account_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (liker_id, target_id),
  CHECK (liker_id <> target_id)
);
CREATE INDEX cloud_likes_target ON cloud_likes(target_id);
-- Trendsetter: each model's first day across the board.
CREATE INDEX cloud_buckets_model_day ON cloud_buckets(model, day_key) WHERE model <> '' AND tokens > 0;
