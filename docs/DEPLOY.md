# Deploying

> **Read this first.** The dashboard ships in two privacy tiers and they are not
> interchangeable.
>
> | | `public` | `gated` |
> |---|---|---|
> | Aggregates, charts, cluster table, City Deep Dive | yes | yes |
> | Solar Consultant **name** (filter, ranking, CSV) | yes — deliberate exception | yes |
> | Drill-down CSV | non-identifying columns only | **full sheet** |
> | SSEID, customer name, SC **email**, Installation Champion | **omitted** | included |
>
> The one exception is `sc_name`. The City Deep Dive tab filters and ranks Solar
> Consultants by name, which is the point of that view, so the name ships in the
> public build and the workflow guard allows it by name. `sc_email` stays
> blocked: a name is not a contactable identifier. **This does put named staff
> performance on a world-readable URL** — that was an explicit call, and Stage 3
> is how to take it back.
>
> **GitHub Pages is world-readable — even from a private repo.** So the Pages
> deployment must be `public`, and it is: the workflow builds `public` unless
> told otherwise. The drill-down still works there, but exports only cluster,
> city, state, dates, capacity and the activation fields. Without SSEID or a
> name, that sheet is not actionable for Sales.
>
> The rest of the full sheet requires `gated`, and `gated` must never be
> published to Pages. Two ways to get it to Sales:
>
> 1. **Google Sheets, domain-restricted** — recommended, see Stage 2. The
>    identity columns go to a Sheet shared only with `@solarsquare.in`; Google
>    enforces that at sign-in, so a leaked link is not a leaked sheet. The
>    dashboard links out to it.
> 2. **Cloudflare Access** (Stage 3) — puts the whole dashboard behind SSO so
>    the in-browser drill-down can carry identity too.
>
> The workflow refuses to publish anything but `mode=public`, and separately
> refuses if any identifying column appears in the payload — `install_id`,
> `customer_name`, `sc_email`, `installation_champion`,
> `installation_champion_email`.


Two stages: GitHub Pages now, Cloudflare Access when the URL needs to stop being
public. The build is identical for both — only the hosting changes.

---

## Stage 1 — GitHub Pages

### 1. Push the repo

```bash
git remote add origin https://github.com/<org>/referral-cohorts.git
git branch -M main
git push -u origin main
```

### 2. Add the secrets

**Settings → Secrets and variables → Actions → New repository secret:**

| secret | value |
|---|---|
| `METABASE_URL` | `https://metabase.yourcompany.com` (no trailing slash) |
| `METABASE_API_KEY` | the read-only key |
| `METABASE_DATABASE_ID` | the id `etl/probe.py` printed |

Repository secrets are not exposed to forked-PR builds and are masked in logs.

### 3. Enable Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

Do not pick "Deploy from a branch" — that would serve the repo contents directly
and skip the ETL entirely.

### 4. Run it

**Actions → Refresh dashboard → Run workflow.** After that it runs daily at
06:00 IST. The URL appears in the workflow summary and under Settings → Pages.

### What the workflow refuses to do

- Deploy when `METABASE_URL` is unset — fails with a clear error rather than
  publishing nothing
- Deploy an empty dataset — usually a broken join or too narrow a lookback
- Deploy synthetic data to a live URL

It warns (but still deploys) when unmapped `activation_source` values appear, so
a new lead source in Metabase surfaces instead of silently inflating "Others".

---

## Stage 2 — The named customer sheet (Google Sheets)

This is what makes the drill-down actionable for Sales without putting names on
a public URL.

### 1. Service account

Google Cloud console → **Create service account** → **Keys → Add key → JSON**.
It needs no IAM roles; access comes from sharing the Sheet with it.
Then **Enable the Google Sheets API** for that project.

### 2. The Sheet

Create an empty Google Sheet. Note its id from the URL
(`docs.google.com/spreadsheets/d/<THIS>/edit`). Then share it twice:

| Share with | Role | Why |
|---|---|---|
| the service account's `client_email` | **Editor** | so the job can write |
| **Anyone at solarsquare.in with the link** | **Viewer** | so Sales can read |

> Use *Anyone at solarsquare.in*, **not** *Anyone with the link*. The second is
> public and defeats the entire point.

### 3. Secrets

Add to **Settings → Secrets and variables → Actions**:

| secret | value |
|---|---|
| `GOOGLE_SHEET_ID` | the id from the URL |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole JSON key file, pasted |

The `sheet` job skips itself when `GOOGLE_SHEET_ID` is unset, so the rest of the
pipeline keeps working until you are ready.

### 4. Run it

```bash
python etl/build.py --mode gated
python etl/export_sheet.py --months 3
```

Defaults to the last three complete months. `--months 6` or `--all` widen it.

The `sheet` job in the workflow does the same on the daily schedule. It builds
gated into `web/data`, pushes to Google, then **deletes `web/data`** so that
build cannot reach the Pages artifact. It is a separate job from `build`, and
`deploy` depends only on `build`.

---

## Stage 3 — Cloudflare Access

Do this before the dashboard carries anything that should not be public, and
before switching to `gated` mode.

### 1. Connect the repo

Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**.

| setting | value |
|---|---|
| Build command | `pip install -r requirements.txt && python etl/build.py` |
| Build output directory | `web` |
| Environment variables | `METABASE_URL`, `METABASE_API_KEY`, `METABASE_DATABASE_ID`, `PRIVACY_MODE` |

Mark `METABASE_API_KEY` as **encrypted** so it is write-only afterwards.

Cloudflare Pages builds run on push. For the daily refresh, either add a
Deploy Hook and call it from the existing GitHub Action on its schedule, or use a
Cloudflare Cron Trigger.

### 2. Gate it

**Zero Trust → Access → Applications → Add an application → Self-hosted:**

- Application domain: your Pages domain
- Policy: *Allow* → Include → **Emails ending in** `@yourcompany.com`
- Identity provider: Google Workspace (or One-time PIN, which needs no IdP setup)

Free for up to 50 users. Viewers hit a company sign-in before the page loads;
nothing static is served to an unauthenticated request.

### 3. Turn on row-level data

Once gated, set `PRIVACY_MODE=gated` in the Cloudflare environment variables.
The build then ships `customer_id`, city, and exact dates, which is what the
non-referrer target lists need to be actionable.

### Retire the public URL

Settings → Pages → **Unpublish site** on GitHub, so a stale public copy is not
left serving yesterday's numbers to anyone holding the old link.

---

## Keeping history

Neither setup keeps snapshots — each deploy replaces the last, and `web/data/` is
gitignored so customer data never enters git history.

If week-over-week comparison becomes useful, the cheapest addition is an Action
step that writes `web/data/aggregates.json` to a dated path in object storage (R2
or S3) after each run. That file is a few KB and contains no row-level data.
