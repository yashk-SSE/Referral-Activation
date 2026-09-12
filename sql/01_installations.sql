-- Extract A: one row per commissioned project (SSEID) = the cohort base.
--
-- Schema notes (SolarSquare Postgres, database id 2):
--   public.project is 389 columns wide and every column is varchar, so dates
--   need an explicit cast and numerics need a regex guard before casting.
--   Timestamps are stored UTC; the business works in IST, so every date
--   comparison converts first -- a project commissioned 23:30 IST would
--   otherwise land in the previous day's cohort.

SELECT
    p."sseid"                                        AS install_id,
    p."prospectId"                                   AS customer_id,
    (CAST(p."commissioning_date" AS timestamp)
        AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                                                     AS install_date,
    NULLIF(TRIM(p."site_address_state"), '')         AS state,
    NULLIF(TRIM(p."site_address_city"), '')          AS city,
    NULLIF(TRIM(p."site_address_cluster"), '')       AS branch,
    CASE WHEN TRIM(p."project_size_kw") ~ '^[0-9]+(\.[0-9]+)?$'
         THEN TRIM(p."project_size_kw")::numeric END AS capacity_kw,
    CASE WHEN TRIM(p."total_price") ~ '^[0-9]+(\.[0-9]+)?$'
         THEN TRIM(p."total_price")::numeric END     AS order_value
FROM public.project p
WHERE p."commissioning_date" IS NOT NULL
  AND NULLIF(TRIM(p."prospectId"), '') IS NOT NULL
  AND (CAST(p."commissioning_date" AS timestamp)
       AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
      BETWEEN (CURRENT_DATE - INTERVAL '{lookback_months} months') AND CURRENT_DATE
  -- only 5 rows in a 24-month window, but they are not part of the base
  AND COALESCE(TRIM(p."project_state"), '') <> 'cancelled'
