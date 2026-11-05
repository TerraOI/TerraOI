-- T-130 follow-up (builder review of #26, B4/B5): close the intake schema to service_role too.
-- 20261105080000 revoked anon and authenticated but left service_role to Supabase's defaults. The
-- intake schema is reached only by inquiry_writer (submit) and pg_cron (prune), so no API-facing
-- role needs anything here. Pinned by supabase/tests/database/030_pilot_inquiries.test.sql.

revoke all on schema intake from service_role;
revoke all on all tables in schema intake from service_role;
revoke all on all functions in schema intake from service_role;

-- Functions added to intake later still default to EXECUTE for PUBLIC (a per-schema default
-- privilege cannot remove that), so each later migration revokes its own new functions.
