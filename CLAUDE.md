# CLAUDE.md

Context for Claude Code working in this repo. Read `HANDOVER.md` for the human
view; this file is the working context — conventions, traps, and what to verify.

## What this is

A static stakeholder dashboard tracking how SolarSquare's installed customer
base converts into referrers. Metabase → GitHub Actions → static JSON → GitHub
Pages. No server, no database connection from the browser, no API key anywhere
near the client.

Live: <https://yashk-sse.github.io/Referral-Activation/> (repo path is
case-sensitive). Repo is **public**.

## Ground rules

**Never publish identity beyond the two agreed exceptions.** The published
build is `public` and the workflow guard in `.github/workflows/refresh.yml`
refuses anything else. `sc_name` and `lead_id` ship publicly by explicit
decision. `install_id` (SSEID), `customer_name`, `sc_email`,
`installation_champion` and `installation_champion_email` must not. If a task
seems to need one of them published, stop and ask.

**`reports/`, `.env`, `docs/schema_db*.json` and `sql/adhoc/*.sql` are
gitignored and carry secrets or customer identity.** Never commit them, never
paste their contents into a message, never publish them to an artifact.

**Numbers must reconcile before you report them.** Every tab derives from one
`statsFor()` in `web/js/data.js`. After any change touching aggregation, assert
in the browser that each cluster's total matches its row on tab 1 and that its
month columns sum to that total. This has caught real bugs more than once.

**Verify against the warehouse, not against memory.** When you state a figure,
run the query. When you change a derivation, recount it independently and show
both numbers.

## Running things

```bash
python etl/build.py --sample          # synthetic, no Metabase
python etl/build.py                   # live, public tier, ~4-8 min
python etl/build.py --mode gated      # adds the identity columns
serve.bat                             # http://localhost:8771
```

Port **8771**, repeated in `.claude/launch.json` under both `port` and
`runtimeArgs` — change both together or the preview serves one port and opens
another. After `--mode gated`, rebuild public before finishing so no gated data
sits in `web/data/`.

`etl/build.py` rewrites the `?v=` asset hashes in `web/index.html`, so run it
after editing any CSS or JS even when the data has not changed.

## Querying Metabase

```python
import sys; sys.path.insert(0, "etl")
from metabase import Metabase, load_dotenv
load_dotenv(".env"); mb = Metabase()
rows = mb.query_paged(sql, 2, key="<unique column>")   # database id 2
```

- `/api/dataset/json` is **blocked by the Cloudflare WAF** — 403 with an HTML
  body that reads like a Metabase permission error. Always `query_paged`.
- **The pagination key must be unique per row.** Paging on a non-unique column
  silently returns duplicates. This has produced a wrong answer here before.
- The key **cannot read or run saved cards** — `/api/card/<id>` is 403. If you
  need a card's SQL, ask the user to paste it.
- Unrestricted scans of `lead` or `project` hit a **Cloudflare 524**. Restrict
  to the relevant set.
- `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` at the top of any
  script that prints warehouse values — this is a Windows cp1252 console.

## Traps that have cost time here

**Timezone conversion depends on the column type.** `varchar` →
`CAST(x AS timestamp) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'`.
`timestamptz` → a **single** `AT TIME ZONE 'Asia/Kolkata'`. Mixing them shifts
by 5h30m. Varchar: `referrals.createdAt`, `project.installation_date`.
Timestamptz: `meeting_schedule_date`, `meeting_done_date`,
`lead.order_closure_datetime`, `freshdesk_ticket.createdAt`.

**`pandas.groupby().first()` skips nulls per column** and will splice one row's
value onto another. Use positional `drop_duplicates(subset=..., keep="first")`.

**Three `public.referrals` columns have a trailing space** in their real names:
`"referrer_role "`, `"utm_campaign "`, `"referrer_email "`.

**`public.city_state_cluster` has 8,998 rows where `cluster` is the literal
string `'None'`** — text, not NULL. `COALESCE` will not catch it. It also has
~27 rows per city, so joining on city fans out.

**`-3 to +90` means `-3 to min(+90, commissioning)`** — the last sub-window is
capped at commissioning and the sub-windows tile the range. Switching the cap
off raises activation 71%. The checkbox defaults on; do not change the default.

**Disabled funnel stages must stay null, not False.** `_attach_funnel_live`
once set NPS columns to `False` unconditionally, which made a disabled stage
render a confident `0`. A placeholder renders `—`.

**Writing JS through Python**: a `\n` inside a replacement string becomes a real
newline and breaks the JS string literal. Check the file parses afterwards.

## Conventions

- Comments explain **why**, not what. Match the density already in the file.
- Every non-obvious derivation gets a comment naming the alternative rejected
  and the reason, with numbers where they exist.
- Docs are part of the change: `docs/DEFINITIONS.md` is authoritative for
  metrics and must be updated in the same commit as any definition change.
- Commit messages: a short subject, then prose explaining the decision and its
  measured consequence. Look at `git log` for the established voice.
- Dashboard copy is one faded line per card, with detail in a `title` tooltip —
  not paragraphs. Explanatory text is `var(--text-3)` so numbers carry weight.

## Current state

Four tabs: Referrer Activation, City Deep Dive, MoM by Cluster, Activation
Speed. Activation window is live-configurable in the browser from per-referral
day-offsets shipped in the payload. IDV is wired (reconnection meetings, as
Metabase card 5318, unwindowed). Cx Recommended is still a placeholder.

Open items are listed in `HANDOVER.md` §8 — the Google Sheets export is the
most useful unfinished piece.
