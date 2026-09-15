"""Build the dashboard datasets.

    python etl/build.py --sample          # synthetic data, no Metabase needed
    python etl/build.py                   # live pull from Metabase
    python etl/build.py --mode gated      # include row-level identifiers

Writes data/*.json, which GitHub Pages (or Cloudflare Pages) serves statically.
The Metabase API key is read from the environment and never reaches the browser.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from datetime import date, datetime

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import transform as T  # noqa: E402
from metabase import Metabase, MetabaseError, load_dotenv  # noqa: E402

DATA_DIR = os.path.join(ROOT, "web", "data")  # served directly by Pages
SQL_DIR = os.path.join(ROOT, "sql")

# Columns shipped to the browser at row level, by privacy tier.
PUBLIC_COLUMNS = [
    "cohort_month", "state", "branch", "capacity_band",
    "install_count", "capacity_kw", "order_value",
    "is_referrer", "is_successful_referrer", "activated_by",
    "sub_channel_pre", "sub_channel_post",
    "first_timing_bucket", "first_tat_from_hoto",
    "referrals_total", "referrals_converted", "months_to_first_referral",
    "days_to_first_referral", "pre_install_referrer", "maturity_months",
]
GATED_EXTRA = ["customer_id", "city", "first_install_date", "first_referral_date",
               "hoto_date", "commissioning_date"]


# ---------------------------------------------------------------------------
def fetch_live(lookback_months: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    load_dotenv(os.path.join(ROOT, ".env"))
    mb = Metabase()
    db_id = int(os.environ.get("METABASE_DATABASE_ID", "0"))
    if not db_id:
        raise MetabaseError("METABASE_DATABASE_ID is not set (run etl/probe.py to find it).")

    print(f"Querying Metabase at {mb.base_url} (database {db_id})...")
    installs = pd.DataFrame(
        mb.query_file(os.path.join(SQL_DIR, "01_installations.sql"), db_id,
                      key="install_id", lookback_months=lookback_months)
    )
    print(f"  installations: {len(installs):,} rows")
    referrals = pd.DataFrame(
        mb.query_file(os.path.join(SQL_DIR, "02_referrals.sql"), db_id,
                      key="referral_id", lookback_months=lookback_months)
    )
    print(f"  referrals:     {len(referrals):,} rows")
    return installs, referrals


def encode_columns(df: pd.DataFrame) -> dict:
    """Column-oriented, dictionary-encoded payload.

    Roughly halves the wire size versus an array of row objects, and the
    dashboard filters over typed arrays instead of re-parsing objects.
    """
    out: dict[str, dict] = {}
    for col in df.columns:
        s = df[col]
        if pd.api.types.is_bool_dtype(s):
            out[col] = {"t": "bool", "v": [bool(x) for x in s.fillna(False)]}
        elif pd.api.types.is_numeric_dtype(s):
            vals = [None if pd.isna(x) else (int(x) if float(x).is_integer() else round(float(x), 2))
                    for x in s]
            out[col] = {"t": "num", "v": vals}
        else:
            s = s.astype(object).where(s.notna(), None)
            levels = sorted({x for x in s if x is not None}, key=str)
            index = {lvl: i for i, lvl in enumerate(levels)}
            out[col] = {
                "t": "cat",
                "levels": [str(x) for x in levels],
                "v": [None if x is None else index[x] for x in s],
            }
    return out


def stamp_assets() -> None:
    """Rewrite ?v= on the CSS/JS tags in index.html to a content hash.

    Pages and Cloudflare both cache static assets for minutes to hours. Without
    this, a fix to the dashboard reaches stakeholders whenever their browser
    happens to revalidate, which is indistinguishable from the fix not working.
    """
    import hashlib
    import re

    index = os.path.join(ROOT, "web", "index.html")
    if not os.path.exists(index):
        return
    with open(index, "r", encoding="utf-8") as fh:
        html = fh.read()

    def rewrite(match: "re.Match[str]") -> str:
        attr, url = match.group(1), match.group(2)
        rel = url.split("?")[0]
        asset = os.path.join(ROOT, "web", rel)
        if not os.path.exists(asset):
            return match.group(0)
        with open(asset, "rb") as fh:
            digest = hashlib.sha1(fh.read()).hexdigest()[:8]
        return f'{attr}="{rel}?v={digest}"'

    html = re.sub(r'(href|src)="((?:js/|vendor/)?[\w./-]+\.(?:css|js))(?:\?v=[\w]+)?"', rewrite, html)
    with open(index, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("  index.html asset hashes stamped")


def write_json(path: str, payload: object, gzip_too: bool = True) -> None:
    raw = json.dumps(payload, separators=(",", ":"), default=str)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(raw)
    size = len(raw.encode("utf-8"))
    note = f"{size / 1024:.0f} KB"
    if gzip_too:
        gz = gzip.compress(raw.encode("utf-8"), 9)
        note += f" ({len(gz) / 1024:.0f} KB gzipped)"
    print(f"  {os.path.relpath(path, ROOT)}  {note}")


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="use synthetic data instead of Metabase")
    ap.add_argument("--mode", choices=["public", "gated"], default=os.environ.get("PRIVACY_MODE", "public"),
                    help="public drops row-level identifiers; gated ships them")
    ap.add_argument("--months", type=int, default=int(os.environ.get("LOOKBACK_MONTHS", "24")))
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)

    if args.sample:
        import sample_data
        print(f"Generating synthetic data ({args.months} month window)...")
        installs, referrals = sample_data.generate(months=args.months)
        print(f"  installations: {len(installs):,} rows")
        print(f"  referrals:     {len(referrals):,} rows")
    else:
        try:
            installs, referrals = fetch_live(args.months)
        except MetabaseError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            print("Tip: run `python etl/build.py --sample` to build against synthetic data.",
                  file=sys.stderr)
            return 1

    as_of = date.today()
    sub_map = T.load_sub_channel_map(os.path.join(HERE, "sub_channel_map.json"))
    base, ref_detail, unmapped = T.build_customer_base(installs, referrals, sub_map, as_of)

    summary = T.summarise(base, unmapped)
    print(
        f"\n{summary['customers']:,} customers / {summary['installs']:,} installs -> "
        f"{summary['referrers']:,} referrers ({summary['activation_rate']}%)"
    )
    if unmapped:
        print(f"\n  !! {len(unmapped)} referral value(s) fell into the Others Sub-Channel:")
        for value, count in unmapped.most_common(10):
            print(f"       {value!r}  x{count}")
        print("     Map them in etl/sub_channel_map.json if they should not be Others.")

    columns = PUBLIC_COLUMNS + (GATED_EXTRA if args.mode == "gated" else [])
    columns = [c for c in columns if c in base.columns]
    shipped = base[columns].copy()
    for col in ("first_install_date", "first_referral_date",
                "hoto_date", "commissioning_date"):
        if col in shipped.columns:
            shipped[col] = pd.to_datetime(shipped[col], errors="coerce").dt.strftime("%Y-%m-%d")

    print(f"\nWriting datasets (mode={args.mode}):")
    write_json(os.path.join(DATA_DIR, "customers.json"),
               {"n": int(len(shipped)), "columns": encode_columns(shipped)})
    write_json(os.path.join(DATA_DIR, "aggregates.json"), {
        "summary": summary,
        "timing": T.timing_summary(base, ref_detail),
        "trajectory": T.trajectory(base, ref_detail),
    })
    write_json(os.path.join(DATA_DIR, "meta.json"), {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "as_of": as_of.isoformat(),
        "mode": args.mode,
        "lookback_months": args.months,
        "source": "sample" if args.sample else "metabase",
        "sub_channels": T.SUB_CHANNELS,
        "timing_buckets": T.TIMING_BUCKETS,
        "unmapped_source_count": len(unmapped),
    }, gzip_too=False)

    stamp_assets()
    print("\nDone. Preview with:  python -m http.server 8000 --directory web")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
