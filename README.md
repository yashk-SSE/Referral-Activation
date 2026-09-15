# Referral Cohorts

A stakeholder dashboard tracking how the installation base converts into referrers:
how many, what activated them, how fast, and what they do next.

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
                                       browser filters all six cuts locally
```

Two design decisions worth knowing:

**The API key never reaches the browser.** A static page cannot hold a secret —
anything it uses to call Metabase is visible in DevTools. So the key stays in
GitHub Secrets, the Action queries Metabase, and only derived JSON is published.

**All six cuts are computed in the browser from one row set.** Filters reshape
every view at once and the cuts cannot drift apart, because they all derive from
the same rows. At ≤25k customers this is a few milliseconds of work.

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
python -m http.server 8000 --directory web
```

Open <http://localhost:8000>. The header shows a **SAMPLE DATA** badge so
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

Fill in `sql/01_installations.sql` and `sql/02_referrals.sql`. They must alias
their output columns to the names in [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md)
— that mapping is the only contract between your warehouse and this dashboard.

### 4. Map the activation sources

Run the build once and read the log:

```bash
python etl/build.py
```

Any raw `activation_source` value not recognised is listed as unmapped and
counted into `Others`. Add the real values to `etl/source_map.json` under the
right bucket and re-run. The dashboard footer shows the unmapped count, so this
never rots silently.

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

## The six cuts

| tab | question it answers |
|---|---|
| **Overview** | How many installs become referrers, and how that rate matures month by month |
| **Who activates them** | Sales / Online / BTL / CApp / Ops-AMC / Others — attributed to the *first* referral, with each channel's yield |
| **Geography & branch** | Where activation is strong or weak, and which large branches underperform |
| **Timing** | How long until the first referral, and how pre-install referrers differ |
| **Trajectory** | Whether referrers keep going after the first — depth, velocity, and which channel creates lasting referrers |
| **Coverage gap** | The never-referred base, filtered to customers mature enough to judge, ranked by headroom |

### Two things the dashboard deliberately guards against

**Young cohorts are not failing cohorts.** A cohort installed last month has had
one month to refer. Every cohort comparison is either maturity-masked (the
triangle leaves future months blank) or indexed at a fixed age.

**Referrals belong to customers, not installations.** A customer with two
installs would otherwise be counted twice. The base is one row per customer,
cohorted on their first install date.
