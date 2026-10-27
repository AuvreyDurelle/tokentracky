-- Visits from tagged links: one count per UTC day and tag.
-- No IP address, cookie, account or profile is stored. Read in SQL; never routed.
CREATE TABLE cloud_share_visits (
  day date NOT NULL,
  tag text NOT NULL CHECK (tag IN ('share', 'readme')),
  count bigint NOT NULL CHECK (count > 0),
  PRIMARY KEY (day, tag)
);
