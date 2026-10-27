-- Short-lived browser approvals. The collector holds only the poll secret; the device token is minted on pickup.
CREATE TABLE cloud_device_authorizations (
  id uuid PRIMARY KEY,
  poll_hash text NOT NULL UNIQUE,
  user_code text NOT NULL UNIQUE CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$'),
  device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 80),
  account_id text REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
