# Referral Cohorts

A stakeholder dashboard tracking how the installed base converts into referrers:
how many, which Sub-Channel activated them, when relative to their own
installation, and how many of those referrals became orders.

Data comes from Metabase. The dashboard is static — no server, no database
connection from the browser, no API key anywhere near the client.

---

## How it works

```
Metabase ──(read-only key, GitHub Secrets)──▶ GitHub Actions, daily 06:00 IST
                                                        │
                                              etl/ runs SQL, derives cohorts
                                                        ▼
                                              web/data/*.json  (~100-300 KB)
                                                        │
                                              GitHub Pages (static hosting)
                                                        ▼
                                        browser filters every cut locally
```

Two design decisions worth knowing:

**The API key never reaches the browser.** A static page cannot hold a secret —
anything it uses to call Metabase is visible in DevTools. So the key stays in
GitHub Secrets, the Action queries Metabase, and only derived JSON is published.

**Every cut is computed in the browser from one row set.** Filters reshape all
three tabs at once and the cuts cannot drift apart, because they all derive from
the same rows. At ~47k customers this is a few milliseconds of work.

---

## Definitions

Every metric — installation, referrer, successful referrer, Sub-Channel, the
timing buckets, the lookback window — is defined in
**[docs/DEFINITIONS.md](docs/DEFINITIONS.md)**, along with the validation run
that reconciles the pipeline against independent SQL. Read that before quoting
a number to anyone.

## Quick start (no Metabase needed)

```bash
pip install -r requirements.txt
python etl/build.py --sample
```

Then start the local server — double-click `serve.bat`, or:

```bash
python -m http.server 8765 --directory web
```

Open <http://localhost:8765>. Opening `web/index.html` directly from disk will
not work: the page loads its data with `fetch()`, which browsers block on
`file://` URLs. The header shows a **SAMPLE DATA** badge so
synthetic numbers can never be mistaken for real ones.

---

## Wiring up Metabase

### 1. Credentials

Create a **read-only** API key in Metabase (Settings → Admin → API keys), assigned
to a group with view access to the relevant database. Then:

```bash
cp .env.example .env
```

Fill in `METABASE_URL` and `METABASE_API_KEY`. `.env` is gitignored — the key must
never be committed or pasted into chat, tickets, or Slack.

### 2. Discover the schema

```bash
python etl/probe.py                              # list databases, check permissions
python etl/probe.py --db 2 --grep install referr customer
```

This reports whether the key can run native SQL, and dumps every matching table
and column to `docs/schema_db<N>.json`. Set `METABASE_DATABASE_ID` in `.env` from
the id it prints.

If native SQL is **BLOCKED**, the key's permission group lacks "Native query
editing". Either grant it on that database, or fall back to saved questions —
`etl/metabase.py` can hit `/api/card/<id>/query/json` instead.

### 3. Write the extraction SQL

`sql/01_installations.sql` and `sql/02_referrals.sql` are already written against
the SolarSquare schema. They must alias their output columns to the names in
[docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) — that mapping is the only
contract between the warehouse and this dashboard.

### 4. Check the Sub-Channel mapping

Run the build once and read the log:

```bash
python etl/build.py
```

Any `referrer_role` not recognised is listed and counted into `Others`. Add it
to `etl/sub_channel_map.json` under the right bucket and re-run. The dashboard
footer shows the count too, so this never rots silently.

Note the extraction is ~91 paginated requests and takes roughly ten minutes —
the WAF blocks Metabase's bulk export endpoints. See
[docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md).

---

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md). Short version: push to `main`, enable Pages
with source **GitHub Actions**, and add three repository secrets
(`METABASE_URL`, `METABASE_API_KEY`, `METABASE_DATABASE_ID`).

---

## Privacy tiers

| mode | ships | use when |
|---|---|---|
| `public` *(default)* | anonymous segment rows — cohort, state, branch, channel, size band, referral outcomes | the URL is publicly reachable, as GitHub Pages is |
| `gated` | the above **plus** `customer_id`, city, and exact dates — enables named target lists | the URL is behind Cloudflare Access or equivalent |

Set with `--mode gated` locally, or the `mode` input on a manual workflow run.

> A public GitHub Pages URL is readable by anyone who has it, even from a private
> repo. `public` mode carries no customer identifiers, but it still exposes
> install volumes and referral rates by state and branch. Move to Cloudflare
> Access before treating this as internal-only.

---

## The three tabs

| tab | question it answers |
|---|---|
| **Referrer Activation** | The Sales-facing view: per-city activation inside the −3…+90 day window, with an India total. Click any number to download that list of customers |
| **Overview** | How many installed customers become referrers, when their first referral lands relative to their own installation, and whether they refer again |
| **Sub-Channel** | Sales / Online / CApp / BTL / Ops/AMC / Others — who activated them, each Sub-Channel's quality, the before-vs-after-installation split, and how fast the referral is captured after HOTO |
| **Coverage gap** | The never-referred base by state and cluster, ranked by how many customers are still untapped |

Full definitions for every term are in
**[docs/DEFINITIONS.md](docs/DEFINITIONS.md)**.

### Three things the dashboard deliberately guards against

**Recent months are not failing months.** A customer installed last month has
not lived through the window where most referrals happen. Cohort comparisons
carry that caveat on the chart, and the minimum-age filter makes them
comparable.

**Referrals belong to customers, not projects.** A customer with two projects
would otherwise be counted twice. The base is one row per customer, cohorted on
their first installation.

**"First referral" is ordered by timestamp, not date.** 5,864 customers have
more than one referral on their earliest date and 220 of those carry different
referrer roles — ordering by date alone makes their Sub-Channel arbitrary.
