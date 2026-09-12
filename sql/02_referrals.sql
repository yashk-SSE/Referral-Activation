-- Extract B: one row per referral lead, including the ones that never converted.
-- Aliases on the right of AS are the contract -- see docs/DATA_CONTRACT.md.
-- TODO: replace TABLE/COLUMN placeholders once the schema probe has run.

SELECT
    r.id                          AS referral_id,
    r.referrer_customer_id        AS referrer_customer_id,
    r.created_at                  AS referral_date,
    r.lead_source                 AS activation_source,  -- raw value; mapped in ETL
    r.status                      AS status,
    r.converted_install_id        AS converted_install_id,
    r.converted_at                AS converted_date
FROM   referrals r                          -- TODO: real table
WHERE  r.created_at >= CURRENT_DATE - INTERVAL '{lookback_months} months'
