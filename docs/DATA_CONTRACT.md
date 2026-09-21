# Data contract

Two extracts come out of Metabase (SolarSquare Postgres, **database id 2**).
Everything on the dashboard is derived from them in `etl/transform.py`, so both
tabs share one definition of "referrer", "activated", and "cohort".

Grain: **one row per customer**, cohorted on their first **installation** date.
Referrals attach to a `prospectId`, not to an SSEID, so counting at project
grain would double-count anyone with two projects.

---

## Extract A — `installations` (`sql/01_installations.sql`)

From `public.project`, joined to `usertasks` for the installation milestone.
One row per installed project.

| contract column | source column | notes |
|---|---|---|
| `install_id` | `sseid` | also the pagination key |
| `customer_id` | `prospectId` | joins to `referrals.referredBy` |
| `install_date` | `usertasks` task-039A completion | UTC → IST before casting to date. Deliberately **not** `project.installation_date` — see `sql/01_installations.sql` |
| `hoto_date` | `lead.cx_approval_timestamp` | |
| `commissioning_date` | `project.commissioning_date` | only truncates the post-install windows |
| `sc_name` / `sc_email` | `lead.assigned_sc` → `users` | the Solar Consultant on the customer's order |
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
| `cohort_month` | month of first installation — the column grain of the City Deep Dive matrix |
| `is_referrer` | ≥ 1 referral, lifetime |
| `activated_by` | Sub-Channel of the **first** referral, lifetime |
| `referrer_activated` | ≥ 1 referral inside the activation window |
| `activated_by_window` | Sub-Channel of the first **in-window** referral |
| `first_timing_bucket` | window the first **lifetime** referral fell in — can be the blindspot |
| `activation_window` | window the first **in-window** referral fell in. Non-null exactly when `referrer_activated` |
| `days_to_first_referral` | negative when they referred before installation |
| `pre_install_referrer` | `days_to_first_referral < 0` |
| `maturity_months` | months elapsed since installation |

`first_timing_bucket` and `activation_window` are not interchangeable, and the
difference is not small. A customer whose very first referral fell in the
blindspot but who referred again inside the window is activated — yet their
`first_timing_bucket` sits outside the window entirely. Splitting activated
customers by `first_timing_bucket` dropped 370 of 1,644 on a three-month view.
Every window split uses `activation_window`, which sums back to
`referrer_activated` by construction.

The pre-install split is measured in **days**, not month buckets: a referral 13
days before installation in the same calendar month is "before" by days but
lands in the "same month" bar. Days is the honest headline.
