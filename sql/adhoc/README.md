# sql/adhoc/ — local only, never committed

One-off queries kept because they were expensive to get right, not because the
pipeline uses them. `sql/adhoc/*.sql` is gitignored; the numbered
`sql/0N_*.sql` files in the parent directory **are** tracked and are the real
pipeline.

| File | What it does | Why it is not committed |
|---|---|---|
| `calling_list_referral_detail.sql` | Every referral lead given by a named list of customers, one row per referral. A customer who referred nobody still gets one row with blank referral columns. Edit the `VALUES` block in the `target` CTE to change who is on the list. | Hardcodes **131 real SSEIDs** and selects customer names. The repo is public, so committing it would publish the list. |

Both follow the same conventions as the tracked SQL: installation is `usertasks`
task-039A, Sub-Channel follows `etl/sub_channel_map.json`, and every timestamp is
converted UTC → IST before being truncated to a day.

## Running one

The Metabase API key cannot read or run saved cards, only run SQL. Use
`etl/metabase.py`:

```python
import sys; sys.path.insert(0, "etl")
from metabase import Metabase, load_dotenv
load_dotenv(".env")
mb = Metabase()
rows = mb.query_paged(open("sql/adhoc/calling_list_referral_detail.sql").read(), 2, key="<unique column>")
```

Use `query_paged`, not `query`: `/api/dataset/json` is blocked by the Cloudflare
WAF in front of Metabase and `/api/dataset` caps at 2000 rows per page. The
pagination key must be **unique per row** — paging on a non-unique column
silently returns duplicates.
