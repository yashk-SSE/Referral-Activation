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

-- installation_completed_by is the "Installation Champion" -- the same
-- derivation Metabase card 1466 uses. DISTINCT ON takes the latest completion
-- so the champion matches the installation date we report.
WITH install_task AS (
    SELECT DISTINCT ON ("parameters_projectId")
        "parameters_projectId"                                        AS project_id,
        to_timestamp(NULLIF("timeCompleted", '-1.0')::numeric / 1000)  AS installation_at,
        "completedBy_userId"                                           AS installation_completed_by
    FROM usertasks
    WHERE KEY = '039A'
      AND NULLIF("timeCompleted", '-1.0') IS NOT NULL
    ORDER BY "parameters_projectId",
             to_timestamp(NULLIF("timeCompleted", '-1.0')::numeric / 1000) DESC
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
         THEN TRIM(p."total_price")::numeric END     AS order_value,

    -- Drill-down fields. The users joins are the ones card 1466 uses:
    --   lead.assigned_sc            -> the Solar Consultant
    --   039A completedBy_userId     -> the Installation Champion
    NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(p."customer_first_name"), ''),
                               NULLIF(TRIM(p."customer_middle_name"), ''),
                               NULLIF(TRIM(p."customer_last_name"), ''))), '')
                                                     AS customer_name,
    (CAST(l."order_closure_datetime" AS timestamp)
        AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                                                     AS order_booked_date,
    NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(sc_user."firstName"), ''),
                               NULLIF(TRIM(sc_user."lastName"), ''))), '')
                                                     AS sc_name,
    NULLIF(TRIM(sc_user."emails"), '')               AS sc_email,
    NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(inst_user."firstName"), ''),
                               NULLIF(TRIM(inst_user."lastName"), ''))), '')
                                                     AS installation_champion,
    NULLIF(TRIM(inst_user."emails"), '')             AS installation_champion_email
FROM public.project p
JOIN install_task it ON it.project_id = p."_id"
LEFT JOIN public.lead l ON l."lead_id" = p."lead_id"   -- not every project resolves to a lead
LEFT JOIN public.users sc_user   ON sc_user."_id"   = l."assigned_sc"
LEFT JOIN public.users inst_user ON inst_user."_id" = it.installation_completed_by
WHERE NULLIF(TRIM(p."prospectId"), '') IS NOT NULL
  AND (it.installation_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
      BETWEEN (CURRENT_DATE - INTERVAL '{lookback_months} months') AND CURRENT_DATE
  AND COALESCE(TRIM(p."project_state"), '') <> 'cancelled'
