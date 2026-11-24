# Handover — Referral Activation dashboard

Everything a new owner needs. Read §1 and §2 before you share or run anything.

**Live:** <https://yashk-sse.github.io/Referral-Activation/> — the repo path is
case-sensitive and needs the trailing slash.
**Repo:** <https://github.com/yashk-SSE/Referral-Activation> (**public**)
**Built by:** Yash Khandelwal (yash.k@solarsquare.in), Sep–Nov 2026.

---

## 1. Before this folder leaves your hands

This folder is **not** safe to hand over as-is. Four things in it never belonged
in the repo and are gitignored, which means they travel with a folder copy while
being invisible in git.

| What | Where | Do this |
|---|---|---|
| **Live Metabase API key** | `.env` → `METABASE_API_KEY` | Delete `.env`. The new owner issues their own key. It is read-only, but it reads the **whole warehouse** — customer names, phones, financials. |
| **Customer-identifying exports** | `reports/` (4 files) | Decide file by file. See `reports/README.md`. Not needed to run or understand anything. |
| **Production schema dump** | `docs/schema_db2.json` | Delete, or keep locally. Regenerate any time with `python etl/probe.py`. |
| **131 real SSEIDs in a query** | `sql/adhoc/calling_list_referral_detail.sql` | Keep only if they need that calling list. See `sql/adhoc/README.md`. |

```bash
# minimum before sharing
rm .env docs/schema_db2.json
rm -rf reports/ etl/__pycache__/ web/data/
```

`web/data/` is rebuilt by the Action on every deploy, so deleting it costs
nothing.

> **One unresolved item.** `docs/schema_db2.json` was committed early and later
> removed (commit `ce32da5`), but **it is still in the public repo's git
> history**. Rewriting history would purge it. That was never done. Decide
> whether it matters to you.

---

## 2. Access the new owner needs

| Thing | Why | Who grants it |
|---|---|---|
| Metabase account + **read-only API key** | ETL runs SQL against database id **2** (SolarSquare, Postgres) | Metabase admin |
| GitHub write access to the repo | push, and read Actions | Yash / repo admin |
| Repo secrets set | `METABASE_URL`, `METABASE_API_KEY`, `METABASE_DATABASE_ID` under Settings → Secrets → Actions | repo admin |

**The API key can run SQL but cannot read or run saved Metabase cards.**
`/api/card/<id>` returns 403. If you need a card's SQL, someone has to paste it
to you. This came up twice and cost real time both times.

---

## 3. Running it

```bash
pip install -r requirements.txt
python etl/build.py --sample      # synthetic data, no Metabase needed
serve.bat                          # or: python -m http.server 8771 --directory web
```

Open <http://localhost:8771>. Opening `web/index.html` from disk fails —
`fetch()` is blocked on `file://`.

Against real data:

```bash
cp .env.example .env               # then fill in the three METABASE_* values
python etl/build.py                # public tier, 24-month lookback
python etl/build.py --mode gated   # adds SSEID, customer name, SC email, Champion
```

A full build takes **4–8 minutes**, almost all of it paging ~56k referral rows
out of Metabase.

> Port 8771, not 8765 — another project on the original dev machine held 8765.
> The port appears **twice** in `.claude/launch.json` (`port` and inside
> `runtimeArgs`). Change both or the preview starts a server on one port and
> opens the other.

---

## 4. How it fits together

```
Metabase (db 2) ──read-only key, GitHub Secrets──▶ GitHub Actions, 06:00 IST daily
                                                            │
                                            sql/0N_*.sql → etl/transform.py
                                                            ▼
                                                  web/data/*.json  (~9 MB)
                                                            │
                                                   GitHub Pages (static)
                                                            ▼
                                        browser computes every cut locally
```

| Path | What |
|---|---|
| `sql/01_installations.sql` | the install base — one row per project |
| `sql/02_referrals.sql` | every referral, any outcome |
| `sql/03_cx_recommended.sql` | **not wired up**, placeholder |
| `sql/04_idv.sql` | IDV — reconnection meetings |
| `etl/transform.py` | all business logic; cohorts, Sub-Channel, windows |
| `etl/build.py` | orchestrates, picks the privacy tier, writes JSON |
| `etl/metabase.py` | API client with keyset pagination |
| `web/js/data.js` | decode + every aggregation, incl. the live window |
| `web/js/app.js` | filters, tabs, panels |
| `web/js/charts.js` | ECharts wrappers + all three table renderers |
| `web/js/export.js` | the click-to-download CSV |

The dashboard has **four tabs**: Referrer Activation, City Deep Dive, MoM by
Cluster, Activation Speed.

---

## 5. Decisions, and why

Metric definitions live in **`docs/DEFINITIONS.md`** (666 lines, authoritative).
These are the decisions behind them.

**Installation is `usertasks` task-039A, not `project.installation_date`.** The
two agree within 0.1%, but 039A is the reconciled one and matches Metabase card
1466.

**The base is one row per customer**, cohorted on their *first* installation.
Referrals attach to `prospectId`, so counting per project would double-count
anyone with two.

**Privacy runs in two tiers.** GitHub Pages is world-readable even from a
private repo, so the published build is `public` and the workflow refuses
anything else. Two deliberate exceptions ship publicly:

- `sc_name` — the City Deep Dive ranks consultants by name; that is the view's point
- `lead_id` — without it a drill-down file has no customer identifier and Sales cannot act on it

SSEID, customer name, SC email and Installation Champion stay gated. Lead IDs
are short and sequential (`RUP9971`), so publishing them makes them enumerable.
Both calls were explicit. `docs/DEPLOY.md` records them.

**The activation window is set in the browser**, not the build. The ETL ships
every referral's day-offset from its own customer's installation (~56k offsets,
CSR-style, ~0.4 MB) and the dashboard re-derives everything for whatever range
is picked.

**IDV is a reconnection meeting**, derived exactly as Metabase card 5318 —
`meeting_metrics_history` where `meeting_type = 'reconnection_meeting'`, one row
per SSEID by latest `updatedAt`, **no date window**. Matching 5318 was chosen
over being more correct, so the dashboard and the card the team reads agree.

**Cx Recommended is still a placeholder** — renders as `—`, never `0`. A zero
would assert "we did none" when the truth is "we are not measuring it".

---

## 6. The traps

Each of these cost real debugging time. They are all live in the code now.

**`-3 to +90` has never meant −3 to +90.** `assign_timing_bucket` caps the last
sub-window at commissioning, and since the sub-windows tile the range, a
referral after commissioning falls out of the window entirely. Jun–Aug
activation is **1,653 with the cap and 2,833 without — 71% higher**. The
*Stop at commissioning* checkbox controls it and defaults **on**, so published
numbers are unchanged. Changing it is a decision about what "activated" means.

**Timezone conversion differs by column type.** `varchar` columns need
`CAST → AT TIME ZONE 'UTC' → AT TIME ZONE 'Asia/Kolkata'`; `timestamptz`
columns need a **single** `AT TIME ZONE 'Asia/Kolkata'`. Using the varchar
recipe on a timestamptz shifts it 5h30m. `referrals.createdAt` and
`project.installation_date` are varchar; `meeting_*_date`,
`lead.order_closure_datetime` and `freshdesk_ticket.createdAt` are timestamptz.

**`pandas.groupby().first()` skips nulls per column.** It will splice a later
project's HOTO date onto the first project's row. Use positional
`drop_duplicates(keep="first")`. This once overstated the Others Sub-Channel by
30%.

**`/api/dataset/json` is blocked by the Cloudflare WAF** in front of Metabase —
403 with an HTML body, which reads like a permission error but is not. Use
`mb.query_paged()`, which pages `/api/dataset` (capped at 2000 rows).

**`query_paged`'s key must be unique per row.** Paging on a non-unique column
silently returns duplicate rows. I produced a wrong answer this way and caught
it only because the number looked odd.

**Unrestricted scans of `lead` or `project` hit a Cloudflare 524.** Restrict to
the set you care about, e.g. `IN (SELECT ... FROM who)`.

**Three columns in `public.referrals` have a trailing space** in their real
names: `"referrer_role "`, `"utm_campaign "`, `"referrer_email "`. Dropping it
gives "column does not exist".

**`public.city_state_cluster` holds 8,998 rows (of 19,364) where the cluster is
the literal string `'None'`** — text, not NULL, so `COALESCE` slides past it.
347 cities affected. Anything joining to it needs `WHERE cluster <> 'None'`.
This is what makes card 5318's per-cluster numbers look lower than ours.

**`public.user_slots_visits_visits` is dead** — nothing at all in 2026.

---

## 7. Data quality to keep in mind

**IDV only ramped in September 2026.** 66% of September installs have a
scheduled meeting against 3–9% for January–August. Near-zero IDV on older
cohorts is missing coverage, not missing visits — and the dashboard's default
view is the last three *complete* months, where it reads almost empty.

**`meeting_done_date` capture is uneven by cluster.** Gurgaon and Delhi logged
zero completions on 205 scheduled meetings in September. **IDV Done is a floor,
not a count, and is not comparable across clusters.** IDV Scheduled is reliable
— every reconnection row has a schedule date.

**The `rn = 1` pick loses completions.** "Most recently updated" is not "the one
that was done": across all 10,241 SSEIDs it reports no done date for ~670 that
do have a completed meeting. On recent installs the cost is small (12 of 401 in
September). Picking the meeting *nearest installation* would be the honest rule
— and would stop matching card 5318, so both would need changing together.

**September's activation is incomplete** until its 90-day window elapses. Use
the Activation Speed tab's cumulative curve to compare cohorts fairly: at day
30, June stood at 16.2% and August at 14.0%.

---

## 8. Open items

| Item | State |
|---|---|
| **Google Sheets export** | Code is written and the `sheet` job runs, but it skips itself — `GOOGLE_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` were never set. Setup steps are at the top of `etl/export_sheet.py`. This is how the gated, named customer list reaches Sales. |
| **Cx Recommended** | Placeholder. Source explored but not wired: `public.new_nps_response_live`, question `how_likely_are_you_to_recommend_...`, 0–10, joined on `sse_id`. ~8.1% of the base had answered; 91.5% of those scored 9–10. |
| **`GITHUB_TOKEN` in `.env`** | Empty. Only raises the GitHub API rate limit from 60/hr for CI polling. Harmless. |
| **`docs/schema_db2.json` in git history** | Still there on the public repo. See §1. |
| **Cloudflare Access (Stage 3)** | Not done. It is the way to retire the public/gated split — see `docs/DEPLOY.md`. |
| **Daily run reliability** | Run #79 (19 Nov) failed on the Metabase step; #78 and #80 passed. The deploy correctly skipped, so the site served the previous day's data. Watch for a pattern — a recurring failure is likely the Cloudflare timeout. |

---

## 9. Where the detail is

| Document | Contents |
|---|---|
| `README.md` | What it is, quick start, the four tabs |
| `docs/DEFINITIONS.md` | **Authoritative.** Every metric, every window, every bucket, with the validation runs. Read before quoting a number. |
| `docs/DATA_CONTRACT.md` | The two extracts, column by column, and everything derived in the ETL |
| `docs/DEPLOY.md` | The privacy tiers, the three deployment stages, what the workflow refuses to do |
| `CLAUDE.md` | Context for Claude Code working in this repo |
| `reports/README.md` | What each ad-hoc export is |
| `sql/adhoc/README.md` | The one-off queries and how to run them |

Published analyses that are **not** in the repo (they were chat deliverables):
pre-HOTO referrer % MoM for Apr–Sep 2026 and YTD, the same for successful
referrers, and the Nagpur active/lapsed × escalated 2×2. The two Excel outputs
are in `reports/`.
