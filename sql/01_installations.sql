-- Extract A: one row per installation (the cohort base).
-- Aliases on the right of AS are the contract -- see docs/DATA_CONTRACT.md.
-- TODO: replace TABLE/COLUMN placeholders once the schema probe has run.

SELECT
    i.id                          AS install_id,
    i.customer_id                 AS customer_id,
    i.commissioned_on             AS install_date,
    i.booked_on                   AS booking_date,
    c.state                       AS state,
    c.city                        AS city,
    i.branch                      AS branch,
    c.source                      AS acquisition_channel,
    i.capacity_kw                 AS capacity_kw,
    i.order_value                 AS order_value,
    i.referred_by_customer_id     AS referred_by_customer_id
FROM   installations i                      -- TODO: real table
LEFT   JOIN customers c ON c.id = i.customer_id   -- TODO: real table
WHERE  i.commissioned_on IS NOT NULL
  AND  i.commissioned_on >= CURRENT_DATE - INTERVAL '{lookback_months} months'
  AND  i.status NOT IN ('cancelled')        -- TODO: confirm exclusions
