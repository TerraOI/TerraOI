-- R-2 (red-team suite 110 #22) — AGENT PROPOSAL for the Lane 2 owner, pending ruling: a lease token is a capability, so members
-- reading their tenant's jobs under scope see every column except it. Table SELECT is replaced by a
-- column list; RLS (ingestion_jobs_scoped_read) is unchanged. Workers reach the column through
-- job_api definer functions only, which this does not touch.
revoke select on table public.ingestion_jobs from authenticated;
grant select (id, organisation_id, source_version_id, stage, executor, status, data_class,
              parser_generation, index_generation, attempt, lease_expires_at, last_error,
              created_at, updated_at, completed_at, lease_fence)
  on table public.ingestion_jobs to authenticated;
