# Data contract

Two flat extracts come out of Metabase. Everything on the dashboard is derived
from these in `etl/transform.py` -- no business logic lives in SQL, so the cuts
stay consistent with each other by construction.

Column names below are what the SQL must alias to. The underlying table and
column names in your warehouse can be anything; the `AS` aliases are the contract.

---

## Extract A -- `installations`

One row per installation. This is the cohort base: the denominator for
"how many of our installs became referrers".

| column | type | required | notes |
|---|---|---|---|
| `install_id` | string | yes | primary key |
| `customer_id` | string | yes | groups multiple installs under one customer; joins to referrals |
| `install_date` | date | yes | commissioning / handover date -- drives the cohort month |
| `booking_date` | date | no | order date; gives us booking-to-install lag |
| `state` | string | no | geography cut |
| `city` | string | no | geography cut |
| `branch` | string | no | branch / office / cluster -- the ops accountability cut |
| `acquisition_channel` | string | no | how this customer was originally acquired |
| `capacity_kw` | number | no | system size |
| `order_value` | number | no | for revenue-weighted views |
| `referred_by_customer_id` | string | no | non-null if this sale itself came from a referral -- lets us build the referral tree and measure second-generation referrals |

## Extract B -- `referrals`

One row per referral lead, whatever its outcome. Losing the un-converted ones
would make the activation-source analysis meaningless, so this must include
every lead, not just the won ones.

| column | type | required | notes |
|---|---|---|---|
| `referral_id` | string | yes | primary key |
| `referrer_customer_id` | string | yes | joins to `installations.customer_id` |
| `referral_date` | date | yes | when the lead was created |
| `activation_source` | string | yes | **the key field** -- Sales / Online / BTL / CApp / Ops-AMC / Others |
| `status` | string | no | current lead stage |
| `converted_install_id` | string | no | non-null once the lead became an installation |
| `converted_date` | date | no | when it converted |

### On `activation_source`

This is the field the whole "how are they being converted" question hangs on.
Three things to confirm:

1. **Where does it live?** A lead-source column, a campaign / UTM field, the
   creating user's team, or something we have to derive from who touched the
   lead first.
2. **What are the raw values?** They will not be the six clean buckets. The ETL
   keeps a mapping table so raw values fold into Sales / Online / BTL / CApp /
   Ops-AMC / Others, and anything unmapped surfaces loudly rather than silently
   landing in Others.
3. **Is it set at lead creation or overwritten later?** If it gets overwritten
   by the closing channel, it answers "who closed it" rather than "who activated
   them" -- a different question, and we'd want the creation-time value.

---

## Derived in ETL, not SQL

| field | definition |
|---|---|
| `cohort_month` | month of `install_date` |
| `is_referrer` | customer has >= 1 referral |
| `first_referral_date` | min `referral_date` per customer |
| `activation_source` (customer level) | source of the **first** referral -- what actually activated them |
| `pre_install_referrer` | `first_referral_date` < `install_date` |
| `months_to_first_referral` | whole months from install to first referral; negative for pre-install |
| `referral_rank` | 1st, 2nd, 3rd ... referral per customer, for the trajectory view |
| `mature_months` | months elapsed since cohort, so young cohorts are compared fairly |

Young cohorts always look worse than old ones because they have had less time to
refer. Every cohort comparison on the dashboard is therefore indexed at a fixed
maturity (e.g. "% who referred within 6 months"), never on a raw lifetime rate.
