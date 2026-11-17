-- ───────────────────────────────────────
-- integration_inbound: what the tracker's webhook deliveries did.
--
-- Until now a tracker's way back failed silently: Linear logged our 401 on
-- its own settings page and the card here still said "Healthy". These
-- columns let the card and the connect dialog say "the webhook works" or
-- "a delivery was refused" without anybody opening the tracker's logs.
--
-- Accepted and refused are kept apart, on purpose (0.1.55 review). An
-- accepted delivery is signed with the connection's secret, so only the
-- tracker can write last_delivery_at. A refused one is unsigned by
-- definition and could come from anybody; it is recorded only when the
-- delivery names exactly one connection, at most once a minute per row, and
-- once an accepted delivery exists it never takes the headline.
--
-- Written by the inbound route under the maintenance claim it already reads
-- with (the tracker holds no org).
--
-- DDL only: no rows are read or written by this file, so no maintenance
-- claim. Under D71, 05 §3 gains the columns in the same commit.
ALTER TABLE integrations
  ADD COLUMN last_delivery_at timestamptz,
  ADD COLUMN last_refused_at timestamptz,
  ADD COLUMN last_refused_error text;
