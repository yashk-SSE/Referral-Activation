-- Extract B: one row per referral lead, whatever its outcome.
--
-- Deliberately NOT limited to the cohort window. We need a customer's full
-- referral history to know whether they referred BEFORE their own
-- commissioning, and to trace what they did after their first referral.
-- Referrals from people outside the install base drop out on the join in
-- transform.py.
--
-- Two schema quirks worth knowing:
--   1. "referrer_role " has a TRAILING SPACE in the actual column name.
--      Dropping it gives: column r.referrer_role does not exist.
--   2. public.lead has many rows per prospectId, so it must be collapsed to
--      one row before joining or the referral count fans out.
--
-- r."referredBy"  = the referrer   (joins to project."prospectId")
-- r."prospectId"  = the person referred (joins to lead."prospectId")

SELECT
    r."_id"                                      AS referral_id,
    r."referredBy"                               AS referrer_customer_id,
    (CAST(r."createdAt" AS timestamp)
        AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                                                 AS referral_date,
    NULLIF(TRIM(r."source"), '')                 AS referral_source,
    NULLIF(TRIM(r."referrer_role "), '')         AS referrer_role,
    NULLIF(TRIM(r."type"), '')                   AS referral_type,
    NULLIF(TRIM(r."status"), '')                 AS status,
    l.max_order_date                             AS converted_date,
    CASE WHEN l.max_order_date IS NOT NULL
         THEN r."prospectId" END                 AS converted_install_id
FROM public.referrals r
LEFT JOIN (
    SELECT
        "prospectId",
        MAX((CAST("order_closure_datetime" AS timestamp)
             AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date) AS max_order_date
    FROM public.lead
    WHERE "order_closure_datetime" IS NOT NULL
    GROUP BY "prospectId"
) l ON r."prospectId" = l."prospectId"
WHERE NULLIF(TRIM(r."referredBy"), '') IS NOT NULL
  -- createdAt carries junk dates (1970, 2001-2012, 2030); fence them out
  AND (CAST(r."createdAt" AS timestamp)
       AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
      BETWEEN DATE '2020-01-01' AND CURRENT_DATE
