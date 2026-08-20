
-- 1) promo_codes: restrict SELECT to admins only (explicit restrictive policy)
DROP POLICY IF EXISTS "Only admins can view promo codes" ON public.promo_codes;
CREATE POLICY "Only admins can view promo codes"
  ON public.promo_codes
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 2) deposits: explicit INSERT scoped to own user_id (edits/deletes remain admin-only)
DROP POLICY IF EXISTS "Users insert own deposits" ON public.deposits;
CREATE POLICY "Users insert own deposits"
  ON public.deposits
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- 3) zapupi_deposits: explicit INSERT scoped to own user_id; block non-admin update/delete
DROP POLICY IF EXISTS "Users insert own zapupi deposits" ON public.zapupi_deposits;
CREATE POLICY "Users insert own zapupi deposits"
  ON public.zapupi_deposits
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins manage zapupi deposits" ON public.zapupi_deposits;
CREATE POLICY "Admins manage zapupi deposits"
  ON public.zapupi_deposits
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 4) organic_run_schedule: explicit admin-only INSERT & DELETE (writes normally via service_role)
DROP POLICY IF EXISTS "Only admins insert runs" ON public.organic_run_schedule;
CREATE POLICY "Only admins insert runs"
  ON public.organic_run_schedule
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Only admins delete runs" ON public.organic_run_schedule;
CREATE POLICY "Only admins delete runs"
  ON public.organic_run_schedule
  FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 5) Admin RPC guards — add in-function admin checks & restrict grants
CREATE OR REPLACE FUNCTION public.get_cron_jobs()
 RETURNS TABLE(jobid bigint, schedule text, command text, nodename text, nodeport integer, database text, username text, active boolean, jobname text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN QUERY
    SELECT j.jobid, j.schedule, j.command, j.nodename, j.nodeport, j.database, j.username, j.active, j.jobname
    FROM cron.job j;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cron_run_details(p_job_id integer)
 RETURNS TABLE(runid bigint, jobid bigint, job_pid integer, database text, username text, command text, status text, return_message text, start_time timestamp with time zone, end_time timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN QUERY
    SELECT r.runid, r.jobid, r.job_pid, r.database, r.username, r.command, r.status, r.return_message, r.start_time, r.end_time
    FROM cron.job_run_details r
    WHERE r.jobid = p_job_id
    ORDER BY r.start_time DESC
    LIMIT 50;
END;
$function$;

-- Revoke broad EXECUTE and grant only to service_role for cron introspection
REVOKE EXECUTE ON FUNCTION public.get_cron_jobs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_cron_run_details(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cron_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_cron_run_details(integer) TO service_role;

-- get_admin_dashboard_stats & get_admin_users_summary already contain has_role check,
-- but tighten grants to service_role only (edge functions call with service role)
REVOKE EXECUTE ON FUNCTION public.get_admin_dashboard_stats() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_admin_users_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_stats() TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_users_summary() TO service_role, authenticated;
-- (authenticated grant retained because the in-function has_role check enforces admin;
--  non-admin callers get an exception, matching linter guidance.)
