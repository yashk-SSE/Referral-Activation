# Definitions

Every number on the dashboard resolves to one of the definitions below. Where a
definition was a judgement call rather than a given, that is said explicitly.

Source: SolarSquare Postgres via Metabase, **database id 2**.
Last validated: **2026-09-15** against Jun–Aug 2026 (see [Validation](#validation)).

---

## 1. Milestone dates

All three are stored in UTC and converted to **IST (Asia/Kolkata)** before being
truncated to a day. Without the conversion, anything after 18:30 UTC lands in
the previous day's bucket.

| Milestone | Source | Notes |
|---|---|---|
| **HOTO** | `lead.cx_approval_timestamp` | joined `project.lead_id = lead.lead_id` (LEFT JOIN — not every project resolves to a lead). Present for 87.8% of projects |
| **Installation** | `usertasks` task-`039A` completion, `MAX(to_timestamp(timeCompleted / 1000))` | joined on `project._id`; `usertasks` has no `sseid`. `timeCompleted = '-1.0'` means not complete and is nulled out |
| **Commissioning** | `project.commissioning_date` | |

**Installation is deliberately not `project.installation_date`.** Task-039A is
the definition the Referral Dashboards project reconciled against Metabase card
1466 ("OMS Plants") on 2026-08-04. The two agree within 0.1% over 24 months
(46,815 vs 46,780), so this choice barely moves the totals — but it keeps this
dashboard consistent with the rest of the reporting stack.

---

## 2. The base — "installed in the last *n* months"

One row per **customer** (`project.prospectId`), not per project.

- A customer enters the base if they have at least one project whose
  **installation date** falls in the window.
- The window is `CURRENT_DATE - INTERVAL 'n months'` to `CURRENT_DATE`,
  inclusive, on the IST installation date. Default `n = 24`
  (`LOOKBACK_MONTHS`).
- Projects with `project_state = 'cancelled'` are excluded (5 rows in 24
  months).
- Projects with a blank `prospectId` are excluded.
- A customer's **cohort month** is the month of their **first** installation in
  the window.

**Why per customer, not per project:** referrals attach to a `prospectId`, not
to an SSEID. A customer with two projects would have their referrals counted
twice at project grain. In practice this is a small effect here — 46,799
customers to 46,801 projects over 24 months — but the grain is correct either
way.

---

## 3. Referrals

One row per referral lead, whatever its outcome — un-converted leads included,
since dropping them would make every rate meaningless.

| Field | Source |
|---|---|
| referrer | `referrals.referredBy` → joins to `project.prospectId` |
| person referred | `referrals.prospectId` → joins to `lead.prospectId` |
| referral date | `referrals.createdAt`, IST |
| order | `MAX(lead.order_closure_datetime)` per `prospectId`, IST |

`referredBy` and `prospectId` are different people. Swapping them inverts the
entire analysis.

`public.lead` holds **many rows per `prospectId`**, so it is collapsed to one
row (`GROUP BY prospectId`, `MAX(order_closure_datetime)`) before joining. Join
it raw and the referral counts fan out.

**Referrals are not restricted to the installation window.** A customer's full
history from 2020 onward is pulled, because whether they referred *before* their
own installation is one of the questions. Dates before 2020 are junk (rows in
1970, 2001–2012, 2030) and are fenced out.

---

## 4. Referrer and successful referrer

| Term | Definition |
|---|---|
| **Referrer** | a customer in the base with **≥ 1 referral** of any outcome |
| **Successful referrer** | a customer in the base with **≥ 1 referral that became an order** |
| **Activation rate** | referrers ÷ base |
| **Success rate** | successful referrers ÷ **base** (not ÷ referrers) |
| **Became orders** | referrals that converted ÷ all referrals given |

"Became an order" means the referred person's `lead` row has a non-null
`order_closure_datetime`. No date ceiling is applied — an order that closed
after the window still counts, because the question is whether the referral ever
converted.

---

## 5. Sub-Channel

**Sub-Channel sits under the Referral channel.** It answers *who activated this
customer*, and is taken from the referrer role on the customer's **first**
referral.

Matching is case-insensitive with **all whitespace removed**, which folds the
spaced Ops variant onto the others.

| Sub-Channel | Rule |
|---|---|
| **Sales** | `referrer_role` ∈ Solar Consultant, LRM, Pre sales Team, SC - Referral Calling |
| **Online** | `referrer_role` = Customer **and** `utm_campaign` ≠ customer_app |
| **CApp** | `referrer_role` = Customer **and** `utm_campaign` = customer_app |
| **BTL** | `referrer_role` = BTL |
| **Ops/AMC** | `referrer_role` ∈ CDM, NPS Sweep Team, Ops(Projects/liaising/O&M/Others), Ops(project/liasing/O&M/others), Ops ( project/ liaising /O&M /others ) |
| **Others** | everything else, **including a blank role** |

Configured in `etl/sub_channel_map.json`; changing a bucket needs no code change.

### Three things to know about this mapping

**Both column names carry a trailing space** — `"referrer_role "` and
`"utm_campaign "`. Without it: `column r.referrer_role does not exist`.

**Online currently resolves to zero.** `utm_campaign` is `customer_app` for
5,290 of 5,290 Customer-role referrals, so all of them go to CApp. The rule is
kept in case that changes.

**Others is 25.9% of referrers, and is broken out a second level.** It is
dominated by referrals with a blank `referrer_role`. Role is blank precisely
when no employee mediated the referral: `Referral - Existing Cx via Emp` is
84.8% populated, `Referral - Existing Cx` is 0.0%. So the bulk of Others is
customers referring on their own.

`others_detail` splits it using the underlying `referrals.source`, for
referrers in the 24-month base:

| Inside Others | Referrers | Share | Success rate |
|---|---|---|---|
| Customer self-serve (`Referral - Existing Cx` / `New Cx`, no role) | 4,996 | 88.8% | 40.2% |
| Employee-led, role not captured (`Existing Cx via Emp`, no role) | 542 | 9.6% | 70.7% |
| HO Team & Others (role present, unassigned in the spec) | 66 | 1.2% | 72.7% |
| Unattributed (no role, no source) | 17 | 0.3% | 29.4% |
| Inbound cc team (role present, unassigned in the spec) | 3 | 0.1% | 100.0% |
| SolarPro Partner (SPP) | 2 | 0.0% | 100.0% |
| SSE employee | 1 | 0.0% | 100.0% |

Only 17 referrers are genuinely unattributed. SPP and SSE are near-zero because
partners and employees are rarely installed customers themselves, so they drop
out on the join to the base.

`SC - Referral Calling` and the spaced Ops variant do not appear in the data
yet; they are mapped for when they do.

---

## 6. Referral timing

Measured for each referrer's **first** referral, relative to **their own**
installation.

| Bucket | Rule |
|---|---|
| **Before installation** | referral date < installation date |
| **Install + 0-3 days** | 0–3 days after installation |
| **Install + 4-7 days** | 4–7 days after installation |
| **Install + 8 days to commissioning** | 8+ days after installation, before commissioning |
| **After commissioning** | referral date ≥ commissioning date |

**Commissioning takes precedence over the day windows.** A referral on day 5 for
a system commissioned on day 4 is *After commissioning*, not *Install + 4-7
days* — once commissioned the customer is a live user, not someone mid-install.
This is the "if commissioning happens in between, take commissioning first"
rule. Customers with no commissioning date simply never reach that bucket.

### Pre-installation TAT

For customers who referred **before** installation: days from **HOTO** to that
first referral, reported as **p50** and **p90**.

- Measured from HOTO, not installation, because HOTO is when the customer
  relationship starts.
- **TAT can be negative** — the referral was captured before the HOTO milestone
  was recorded. This is normal for Sales (p50 is about −1 day), where the
  consultant takes the referral around handover. The dashboard renders these as
  "*N*d before" rather than a bare negative.
- Customers with no HOTO date are excluded (8,269 of 8,278 pre-install
  referrers have one).

### Sub-Channel before vs after installation

Captured separately: the Sub-Channel of a customer's first referral **before**
installation, and of their first referral **at or after** it. A customer who
referred on both sides appears in **both**, so these do not sum to the referrer
count.

---

## 7. "First referral" ordering and null handling

Ordered by the **actual `createdAt` timestamp**, then `referral_id` as a
tie-break — not by date alone.

This matters: 5,864 customers have more than one referral on their earliest
date, and **220 of those carry different referrer roles**. Ordering by date
alone makes "the first referral" ambiguous, and the Sub-Channel assigned to
those customers becomes arbitrary and unstable between runs.

The first referral's row is taken **positionally**, with
`drop_duplicates(keep='first')` rather than `groupby().first()`. Pandas'
`groupby().first()` skips nulls *per column*, so it will splice a later
referral's value into the first referral's row wherever the first row is null —
which overstated Others by 30% (7,324 against a true 5,627) until it was caught
by cross-checking `others_detail` against `activated_by`. The same applies to
the first project's row, where a later project's HOTO date could otherwise be
spliced in.

---

## 8. Other fields

| Field | Source |
|---|---|
| State / City / Cluster | `project.site_address_state` / `_city` / `_cluster` |
| Capacity | `project.project_size_kw`, summed per customer |
| Order value | `project.total_price`, summed per customer |
| Maturity | whole months from first installation to today |

Every column in `public.project` is `varchar`, so numerics are regex-guarded
(`~ '^[0-9]+(\.[0-9]+)?$'`) before casting. A bad value becomes null rather
than failing the whole query.

---

## Validation

Jun–Aug 2026, cohorted on first installation month. Each figure was computed
twice: once through the ETL, once by a standalone SQL query written from these
definitions without reference to the pipeline code.

| Month | Customers | Referrers | Activation | Successful | Referrals | Orders |
|---|---|---|---|---|---|---|
| 2026-06 | 3,716 | 1,474 | 39.7% | 657 | 3,083 | 853 |
| 2026-07 | 3,581 | 1,293 | 36.1% | 556 | 2,651 | 708 |
| 2026-08 | 3,270 | 1,025 | 31.3% | 433 | 1,969 | 533 |
| **Total** | **10,567** | **3,792** | **35.9%** | **1,646** | **7,703** | **2,094** |

Sub-Channel and timing for the same cohort, both reconciling exactly:

| Sub-Channel | Referrers | | Timing of first referral | Referrers |
|---|---|---|---|---|
| Sales | 2,215 | | Before installation | 1,994 |
| BTL | 706 | | Install + 0-3 days | 607 |
| Others | 512 | | Install + 4-7 days | 170 |
| CApp | 207 | | Install + 8d to commissioning | 277 |
| Ops/AMC | 152 | | After commissioning | 744 |
| Online | 0 | | | |

Activation falls month over month (39.7% → 36.1% → 31.3%) because the referral
window has not finished running for the newer cohorts, not because those months
are worse. Use the minimum-age filter to compare like with like.

The first run of this comparison disagreed by 1–3 customers per Sub-Channel.
The cause was the same-date ambiguity in Section 7, in the reference query
rather than the pipeline. Both now order deterministically and agree exactly.
