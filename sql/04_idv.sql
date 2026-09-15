-- Extract D: Installation Day Visit task completions, one row per completion.
--
-- Visits used to live in public.user_slots_visits_visits, but that table is
-- dead -- 8.5k rows in 2023, 38.9k in 2024, 4.6k in 2025 and NOTHING in 2026.
-- Visits are now usertasks, which is current (3.8M completions in 2026).
--
-- SC_IDV_01 is the task literally described "Installation Day Visit". It was
-- created in September 2026, so it is near-empty until adoption picks up. The
-- key list is injected from etl/funnel_config.json so it can be widened (046
-- "Visit site for quality audit" and NM015 "Conduct Pre-commissioning Site
-- Visit" are the nearest higher-volume alternatives) without editing SQL.
--
-- The +/- day window is NOT applied here. Visit dates are returned raw and the
-- window is applied in transform.py, so the configured window is honoured in
-- one place rather than baked into an extract.
--
-- usertasks has no sseid, so it joins on project._id.
-- timeCompleted is epoch milliseconds as text; '-1.0' means not completed.

SELECT
    u."_id"                                                 AS visit_id,
    p."sseid"                                               AS install_id,
    p."prospectId"                                          AS customer_id,
    u."key"                                                 AS task_key,
    (to_timestamp(NULLIF(u."timeCompleted", '-1.0')::numeric / 1000)
        AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                                                            AS visit_date
FROM public.usertasks u
JOIN public.project p ON p."_id" = u."parameters_projectId"
WHERE u."key" IN ({idv_keys})
  AND NULLIF(u."timeCompleted", '-1.0') IS NOT NULL
  AND NULLIF(TRIM(p."prospectId"), '') IS NOT NULL
