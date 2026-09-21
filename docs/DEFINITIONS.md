# Definitions

Every number on the dashboard resolves to one of the definitions below. Where a
definition was a judgement call rather than a given, that is said explicitly.

Source: SolarSquare Postgres via Metabase, **database id 2**.
Last validated: **2026-09-15** against Jun–Aug 2026 (see [Validation](#validation)).
The Jun–Aug Sub-Channel figures in that section predate the Online amendment in
Section 5; the base, referrer and timing figures are unaffected by it.

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
| **Online** | `referrer_role` = Customer **and** `utm_campaign` ≠ customer_app, **or** `referrer_role` **blank** and source in `Referral - Existing Cx` / `Referral - New Cx` |
| **CApp** | `referrer_role` = Customer **and** `utm_campaign` = customer_app |
| **BTL** | `referrer_role` = BTL |
| **Ops/AMC** | `referrer_role` ∈ CDM, NPS Sweep Team, Ops(Projects/liaising/O&M/Others), Ops(project/liasing/O&M/others), Ops ( project/ liaising /O&M /others ) |
| **Others** | everything else, **including a blank role** |

Configured in `etl/sub_channel_map.json`; changing a bucket needs no code change.

### Three things to know about this mapping

**Both column names carry a trailing space** — `"referrer_role "` and
`"utm_campaign "`. Without it: `column r.referrer_role does not exist`.

**Online has a second arm (amended 2026-09-15).** The original rule alone
resolved to zero: `utm_campaign` is `customer_app` for 5,290 of 5,290
Customer-role referrals, so all of them went to CApp. Meanwhile ~5,000
customer-initiated referrers sat in Others. `referrer_role` is populated only
when an employee took the referral, so a **blank** role on an `Existing Cx`
referral means the customer raised it themselves — campaign-prompted or not.
Those are now Online, and the campaign split is kept in `sub_channel_detail`.

**Others is now 2.9% of referrers** (631), down from 25.9% before the Online
amendment moved customer-initiated referrals out of it.

`sub_channel_detail` carries a second level for the two Sub-Channels that are
not one population, for referrers in the 24-month base:

| Sub-Channel | Detail | Referrers | Success rate |
|---|---|---|---|
| Online | Campaign-driven (**has** `utm_campaign`) | 2,734 | 33.2% |
| Online | Unprompted (**no** `utm_campaign`) | 2,263 | 48.7% |
| Others | Employee-led, role not captured (`Existing Cx via Emp`, no role) | 542 | 70.7% |
| Others | HO Team & Others (role present, unassigned in the spec) | 66 | 72.7% |
| Others | Unattributed (no role, no source) | 17 | 29.4% |
| Others | Inbound cc team (role present, unassigned in the spec) | 3 | 100.0% |
| Others | SolarPro Partner (SPP) | 2 | 100.0% |
| Others | SSE employee | 1 | 100.0% |

Only **17 referrers** are genuinely unattributed. SPP and SSE are near-zero
because partners and employees are rarely installed customers themselves, so
they drop out on the join to the base.

Unprompted referrers convert at 48.7% against 33.2% for campaign-driven —
people who refer without being asked are materially better referrers, which the
merged bucket hid.

### `referrer_email` adds nothing — it is collinear with `referrer_role`

Over 24 months, `referrer_email` is populated for **100.0%** of referrals that
have a `referrer_role` and **0.0%** of those that do not, across every role
value. Both fields record the employee who took the referral, so the email
cannot be used to recover attribution where the role is missing. It does
independently confirm that a blank role really does mean no employee was
involved.

### Campaign-driven is not self-serve

Of the no-role `Referral - Existing Cx` referrals, **65.2%** carry a
`utm_campaign` — 15,882 referrals across **499 distinct campaigns**
(`whatsapp_bot`, `Referral_Registration_Done`, `iplbonanza`, and ~490 WhatsApp
blasts such as `W_Transacted_Never_Referred_13June2026_Marathi`). Those were
prompted by marketing, so they are split out rather than called self-serve.

This is where the **Online** population lives, and since 2026-09-15 the rule
captures it — both the campaign-driven and the unprompted halves.

`SC - Referral Calling` and the spaced Ops variant do not appear in the data
yet; they are mapped for when they do.

---

## 5b. Activation window, blindspot, and the funnel

Configured in `etl/funnel_config.json`.

### The activation window

A referral counts as an **activation** only if it lands between
`window_start_days` and `window_end_days` of the customer's installation.
Default **−3 … +90 days** — wide enough to cover installation, commissioning,
subsidy disbursal and the first zero bill, which are the high points for most
customers.

### The blindspot

Referrals **earlier than the window start are excluded from every activation
metric.** They predate the customer having a working system and carry too much
noise to attribute. They stay visible in the lifetime `is_referrer` flag, so the
two views can be compared, but they never reach the Sales tracker.

This is a large exclusion and should be stated whenever these numbers are
shared. Of the 21,758 lifetime referrers over 24 months, where the **first**
referral lands:

| | Referrers | Share |
|---|---|---|
| Before window (blindspot) | 7,671 | 35.3% |
| −3 to +3 | 2,925 | 13.4% |
| +4 to +7 | 802 | 3.7% |
| +8 to commissioning | 1,763 | 8.1% |
| After window (> +90 days) | 8,597 | 39.5% |

**7,179 customers activate in-window** — more than the 5,490 whose *first*
referral is in-window, because a customer whose first referral fell in the
blindspot can still refer again inside the window, and that counts.

### Sub-windows

| Bucket | Rule |
|---|---|
| **−3 to +3** | the hypothesised peak activation window |
| **+4 to +7** | |
| **+8 to commissioning** | day 8 onward, capped at commissioning — whichever comes first |

Past the last sub-window but still inside +90 falls to *After window*, which is
what "or commissioning, whichever comes first" leaves behind.

Actual TAT from installation is reported alongside the buckets (p50, p90, mean
days), because the buckets are a reporting convenience and the distribution is
the underlying truth.

### Terms

| Term | Definition |
|---|---|
| **Referrer activated** | ≥ 1 referral inside the window |
| **Successful referrer activated** | ≥ 1 in-window referral that became an order |
| **# Leads** | in-window referrals |
| **# Orders** | in-window referrals that became orders |
| **Leads / referrer** | # Leads ÷ Referrer activated |
| **Orders / referrer** | # Orders ÷ Referrer activated |

These differ from the lifetime `is_referrer` / `is_successful_referrer` in
Section 4, which ignore the window. Both are shipped; the Sales tracker uses
the windowed ones.

### Cx Recommended and IDV — placeholders

Both are **structural placeholders**. `enabled: false` means the ETL queries no
source and the dashboard renders a dash, **not a zero** — "we have no source"
and "we did none" are different statements and a zero asserts the wrong one.

When the source is agreed, set `enabled: true` and fill in `source`.

Previously explored and deliberately **not** wired up, kept only as a starting
point:

| Stage | Candidate | Note |
|---|---|---|
| Cx Recommended | `public.new_nps_response_live`, question `how_likely_are_you_to_recommend_solarsquare_to_a_friend_or_coll`, 0–10, joined on `sse_id` | 8.1% of the base had answered; 91.5% of those scored 9–10 |
| IDV | `public.usertasks` key `SC_IDV_01` "Installation Day Visit" | went live Sept 2026, 4 records |

If IDV is ever sourced from visits, note that **`public.user_slots_visits_visits`
is dead** — 8,506 rows in 2023, 38,858 in 2024, 4,610 in 2025 and **nothing in
2026**. `usertasks` is the current system.

---

## 5c. Referrer Activation (tab 1)

One row per **cluster** plus an **India (all)** total, over whatever the filters
select. Intended use is the last three complete months — sitting in September,
that is the Jun / Jul / Aug installed base.

Columns: Installed base, Cx Recommended *(placeholder)*, IDV visits
*(placeholder)*, Referrer activation, Act %, Orders activation, Order %,
Not referred, # Leads, # Orders, Leads / referrer, Orders / referrer.

### Drill-down

**Clicking any number downloads exactly those customers as CSV**, with the
dashboard's filters applied. The file is built from rows already in the
browser, so it always matches what was on screen.

| Column | Source |
|---|---|
| SSEID | `project.sseid` |
| Name | `project.customer_first/middle/last_name` |
| Cluster / City / State | `project.site_address_cluster` / `_city` / `_state` |
| Order Booked Date | `lead.order_closure_datetime` |
| HOTO Date | `lead.cx_approval_timestamp` |
| SC Name / Email | `lead.assigned_sc` → `users._id` |
| Install Date | `usertasks` task-039A completion |
| Installation Champion / Email | task-039A `completedBy_userId` → `users._id` |
| Commissioning Date | `project.commissioning_date` |
| Activation fields | Referrer/Successful activated, leads, orders, Sub-Channel, window, days from install |

The two `users` joins are the ones Metabase card 1466 ("OMS Plants") uses.

> **The full drill-down needs `--mode gated`.** SSEID, customer name and
> Installation Champion are identifying, so `public` mode omits them entirely
> and the export degrades to the remaining columns, saying so on screen.
> **Do not deploy in gated mode until the URL is behind Cloudflare Access** —
> see [DEPLOY.md](DEPLOY.md).
>
> **`sc_name` is the one deliberate exception.** The City Deep Dive tab filters
> and ranks Solar Consultants by name, so the consultant's *name* ships in the
> public build. `sc_email` does not — a name is not a contactable identifier.

---

## 5d. City Deep Dive (tab 2)

The same metrics as tab 1, transposed: **metrics down the side, installation
months across the top**, for one cluster at a time.

A column is a **cohort, not a calendar month**. Customers sit in the month their
system was installed; their referrals are then counted inside *that customer's
own* −3…+90 day window. So the newest column is always still filling, and will
keep rising for ninety days after its last installation. It is not a month of
referral activity.

Row groups, in order:

| group | rows |
|---|---|
| Base | Installed base, Cx Recommended *(placeholder)*, IDV visits *(placeholder)* |
| Activation | Referrer activation, Act %, Orders activation, Order %, Not referred |
| Referral output | # Leads, # Orders, Leads / referrer, Orders / referrer |
| Who activated them | one row per Sub-Channel, on `activated_by_window` |
| When they activated | one row per sub-window, on `activation_window` |

The last two groups each split the activated customers exactly once, so each
sums back to **Referrer activation**. They use the first **in-window** referral,
not the first lifetime referral — see `activation_window` in
[DATA_CONTRACT.md](DATA_CONTRACT.md) for why that distinction matters.

Clicking a count downloads those customers. Percentages and per-referrer ratios
are derived rather than a set of rows, so they are not clickable. As on tab 1,
clicking **# Leads** gives the customers who produced those leads, not one row
per lead — the export is a customer list.

### Solar Consultant

A customer is attributed to the consultant on **their own order**
(`lead.assigned_sc` → `users`), which is the book that consultant handed over.
It is **not** who chased the referral afterwards — that is the Sub-Channel, and
the two answer different questions.

- The consultant table always lists every consultant in the selected cluster, so
  they can be ranked against each other. Selecting one narrows the
  month-on-month table to their book alone and highlights their row.
- Customers whose lead carries no `assigned_sc` appear as **(not assigned)**, so
  the consultant rows still sum to the cluster total. That is ~1.5% of the base.
- A consultant with a very small book swings wildly on percentage. Read Act %
  next to Installed base, never alone.

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
