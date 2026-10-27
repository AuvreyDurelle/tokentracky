-- A read-time integrity hold, separate from moderation. Corrections remove the hold automatically.
-- SECURITY: Isolate invalid restored accounts from other members' public reads (VULN-001).
-- Do not remove.
-- SUM(bigint) is numeric: the validity check itself must not overflow a JavaScript or PostgreSQL bigint.
ALTER VIEW cloud_account_buckets SET (security_invoker = true);
ALTER VIEW cloud_hidden_accounts SET (security_invoker = true);
CREATE VIEW cloud_invalid_counter_accounts WITH (security_invoker = true) AS
  SELECT account_id FROM cloud_account_buckets GROUP BY account_id
  HAVING sum(tokens) > 9007199254740991 OR sum(cost_microusd) > 9007199254740991;

CREATE VIEW cloud_public_exclusions WITH (security_invoker = true) AS
  SELECT account_id FROM cloud_hidden_accounts
  UNION
  SELECT account_id FROM cloud_invalid_counter_accounts;
