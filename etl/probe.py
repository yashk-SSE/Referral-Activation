"""Discover what the API key can actually see in Metabase.

Run this first. It verifies the connection, checks whether native SQL is
permitted, and dumps the table/field catalogue so the extraction SQL can be
written against the real schema instead of guesses.

    python etl/probe.py                 # list databases + permission check
    python etl/probe.py --db 2          # dump every table in database 2
    python etl/probe.py --db 2 --grep referr install customer
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from metabase import Metabase, MetabaseError, load_dotenv  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs")


def list_databases(mb: Metabase) -> list[dict]:
    dbs = mb.databases()
    print(f"\n{len(dbs)} database(s) visible to this key:\n")
    for db in dbs:
        print(f"  id={db['id']:<4} {db['name']}  ({db.get('engine')})")
    return dbs


def check_native(mb: Metabase, database_id: int) -> bool:
    """Can we POST raw SQL, or do we have to fall back to saved questions?"""
    try:
        mb.query("SELECT 1 AS probe", database_id, full=False)
        print(f"  native SQL on db {database_id}: ALLOWED")
        return True
    except MetabaseError as exc:
        print(f"  native SQL on db {database_id}: BLOCKED -- {exc}")
        return False


def dump_schema(mb: Metabase, database_id: int, greps: list[str]) -> None:
    meta = mb.database_metadata(database_id)
    tables = meta.get("tables", [])
    if greps:
        needles = [g.lower() for g in greps]
        tables = [
            t
            for t in tables
            if any(n in (t.get("name") or "").lower() for n in needles)
        ]
    tables.sort(key=lambda t: (t.get("schema") or "", t.get("name") or ""))

    print(f"\n{len(tables)} table(s){' matching ' + str(greps) if greps else ''}:\n")
    catalogue = []
    for t in tables:
        fields = sorted(t.get("fields", []), key=lambda f: f.get("name") or "")
        qualified = f"{t.get('schema') or 'public'}.{t['name']}"
        print(f"  {qualified}  ({len(fields)} fields, ~{t.get('rows') or '?'} rows)")
        for f in fields:
            print(f"      {f['name']:<40} {f.get('database_type') or f.get('base_type')}")
        print()
        catalogue.append(
            {
                "schema": t.get("schema"),
                "name": t["name"],
                "rows": t.get("rows"),
                "fields": [
                    {
                        "name": f["name"],
                        "type": f.get("database_type") or f.get("base_type"),
                        "semantic_type": f.get("semantic_type"),
                    }
                    for f in fields
                ],
            }
        )

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"schema_db{database_id}.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(catalogue, fh, indent=2, default=str)
    print(f"Catalogue written to {out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=int, help="database id to inspect")
    ap.add_argument("--grep", nargs="*", default=[], help="only tables matching these substrings")
    args = ap.parse_args()

    load_dotenv()
    try:
        mb = Metabase()
    except MetabaseError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"Connecting to {mb.base_url} ...")
    try:
        dbs = list_databases(mb)
    except MetabaseError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("\nPermission check:")
    targets = [args.db] if args.db else [db["id"] for db in dbs]
    for db_id in targets:
        check_native(mb, db_id)

    if args.db:
        dump_schema(mb, args.db, args.grep)
    else:
        print("\nRe-run with --db <id> to dump that database's table catalogue.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
