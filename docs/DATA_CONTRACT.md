# Data contract

Two extracts come out of Metabase (SolarSquare Postgres, **database id 2**).
Everything on the dashboard is derived from them in `etl/transform.py`, so all
three tabs share one definition of "referrer", "activated", and "cohort".

Grain: **one row per customer**, cohorted on their first commissioning date.
Referrals attach to a `prospectId`, not to an SSEID, so counting at project
grain would double-count anyone with two projects.

---

## Extract A — `installations` (`sql/01_installations.sql`)

From `public.project`. One row per commissioned project.

| contract column | source column | notes |
|---|---|---|
| `install_id` | `sseid` | also the pagination key |
| `customer_id` | `prospectId` | joins to `referrals.referredBy` |
| `install_date` | `commissioning_date` | UTC → IST before casting to date |
| `state` / `city` / `branch` | `site_address_state` / `_city` / `_cluster` | |
| `capacity_kw` | `project_size_kw` | |
| `order_value` | `total_price` | |

Excludes `project_state = 'cancelled'` (5 rows in a 24-month window).

## Extract B — `referrals` (`sql/02_referrals.sql`)

From `public.referrals`, left-joined to a de-duplicated `public.lead` for the
conversion date.

| contract column | source column | notes |
|---|---|---|
| `referral_id` | `_id` | pagination key |
| `referrer_customer_id` | `referredBy` | **the referrer** |
| `referral_date` | `createdAt` | UTC → IST |
| `referrer_role` | `"referrer_role "` | **trailing space in the column name** |
| `referral_source` | `source` | |
| `converted_date` | `MAX(lead.order_closure_datetime)` | per `prospectId` |

`r."prospectId"` is the person being referred, not the referrer — it is what
joins to `lead`. Mixing the two up silently inverts the whole analysis.

Not restricted to the cohort window: a customer's full referral history is
needed to tell whether they referred before their own commissioning.

---

## How activation source is derived

There is no single activation-source column. It comes from two, in order:

1. **`referrer_role`** — if present, it names the employee who prompted the
   referral, and that is the answer.
2. **`referral_source`** — used only when the role is blank.

The blanks are structural, not missing data:

| `source` | rows with a role |
|---|---|
| `Referral - Existing Cx via Emp` | 84.8% |
| `Referral - SSE Emp` | 73.5% |
| `Referral - Existing Cx` | **0.0%** |
| `Referral - SPP` / `SPP via RM` | **0.0%** |

A blank role means no employee was involved — the customer referred on their
own. So `Referral - Existing Cx` with no role maps to **Customer direct**, not
to Others.

Buckets live in `etl/source_map.json` and flow to the dashboard through
`meta.json`, so adding one does not need a code change. Unrecognised values
land in Others **and** are reported in the build log and the dashboard footer.

### What the data does and does not support

| requested bucket | status |
|---|---|
| Sales | `Solar Consultant`, `LRM`, `Pre sales Team`, `Inbound cc team`, `CDM` |
| Ops/AMC | `Ops(...)` in two spellings, `NPS Sweep Team` |
| BTL | `BTL` |
| CApp | no app-specific value exists; the closest is **Customer direct** — referred with no employee involved |
| Online | **not available.** `utm_source` is 98.6% null; there is no digital-channel attribution on referrals |
| Others | `HO Team & Others`, plus anything unmapped |

Two buckets exist in the data that were not in the original list — `Partner
(SPP)` and `Employee (SSE)`. Both are ~0 on this dashboard because partners and
employees are not themselves commissioned customers, so they drop out on the
join. They are kept in the mapping so their referrals are never miscounted as
customer referrals.

---

## Extraction constraints

`/api/dataset/csv` and `/api/dataset/json` are **blocked by Cloudflare** in
front of this Metabase instance — they return a 403 HTML page, which is easy to
misread as a Metabase permission error. `/api/dataset` works but hard-caps at
2000 rows regardless of the `constraints` sent with the request.

So extracts are assembled by `Metabase.query_paged()` using keyset pagination
(`WHERE key > last_seen ORDER BY key LIMIT 2000`) rather than OFFSET, which
re-sorts everything skipped on each page and can drop or repeat rows if the
data shifts mid-run. A 24-month pull is ~91 requests and takes roughly ten
minutes.

---

## Derived in ETL, not SQL

| field | definition |
|---|---|
| `cohort_month` | month of first commissioning |
| `is_referrer` | ≥ 1 referral |
| `activated_by` | activation bucket of the **first** referral |
| `days_to_first_referral` | negative when they referred before commissioning |
| `pre_install_referrer` | `days_to_first_referral < 0` |
| `maturity_months` | months elapsed since commissioning |

The pre-install split is measured in **days**, not month buckets: a referral 13
days before commissioning in the same calendar month is "before" by days but
lands in the "same month" bar on the chart. Days is the honest headline.
