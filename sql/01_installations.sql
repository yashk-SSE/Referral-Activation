-- Extract A: one row per installed project. This is the cohort base.
--
-- The base is keyed on INSTALLATION, not commissioning (which is what the
-- Referral Tiers dashboard uses). Three milestone dates come out of here
-- because the referral-timing buckets need all of them:
--
--   HOTO         lead.cx_approval_timestamp
--   Installation usertasks task-039A completion
--   Commissioning project.commissioning_date
--
-- These are the definitions the Referral Dashboards project settled on
-- (2026-08-05) after reconciling against Metabase card 1466 "OMS Plants".
-- Installation is deliberately NOT project.installation_date -- though the two
-- agree within 0.1% (46,815 vs 46,780 rows over 24 months), task-039A is the
-- reconciled one. usertasks has no sseid, so it joins on project._id.
--
-- Every column in public.project is varchar: dates need an explicit cast and
-- numerics a regex guard. Timestamps are UTC, the business runs on IST, so
-- every date is converted before being truncated to a day.

WITH install_task AS (
    SELECT
        "parameters_projectId" AS project_id,
        MAX(to_timestamp(NULLIF("timeCompleted", '-1.0')::numeric / 1000)) AS installation_at
    FROM usertasks
    WHERE KEY = '039A'
    GROUP BY "parameters_projectId"
)
SELECT
    p."sseid"                                        AS install_id,
    p."prospectId"                                   AS customer_id,
    (it.installation_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                                                     AS install_date,
    (CAST(l."cx_approval_timestamp" AS timestamp)
        AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                                                     AS hoto_date,
    (CAST(p."commissioning_date" AS timestamp)
        AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                                                     AS commissioning_date,
    NULLIF(TRIM(p."site_address_state"), '')         AS state,
    NULLIF(TRIM(p."site_address_city"), '')          AS city,
    NULLIF(TRIM(p."site_address_cluster"), '')       AS branch,
    CASE WHEN TRIM(p."project_size_kw") ~ '^[0-9]+(\.[0-9]+)?$'
         THEN TRIM(p."project_size_kw")::numeric END AS capacity_kw,
    CASE WHEN TRIM(p."total_price") ~ '^[0-9]+(\.[0-9]+)?$'
         THEN TRIM(p."total_price")::numeric END     AS order_value
FROM public.project p
JOIN install_task it ON it.project_id = p."_id"
LEFT JOIN public.lead l ON l."lead_id" = p."lead_id"   -- not every project resolves to a lead
WHERE NULLIF(TRIM(p."prospectId"), '') IS NOT NULL
  AND (it.installation_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
      BETWEEN (CURRENT_DATE - INTERVAL '{lookback_months} months') AND CURRENT_DATE
  AND COALESCE(TRIM(p."project_state"), '') <> 'cancelled'
