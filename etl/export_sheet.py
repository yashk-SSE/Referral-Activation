"""Push the drill-down customer list to a Google Sheet.

This is what makes the named sheet safe to share. The GitHub Pages dashboard is
world-readable, so it ships no customer or staff identity. The identifying
columns go here instead, into a Sheet whose sharing is restricted to the
SolarSquare Workspace domain -- Google enforces that at sign-in, so a leaked
link is not a leaked sheet.

    python etl/export_sheet.py                 # last 3 complete months
    python etl/export_sheet.py --months 6
    python etl/export_sheet.py --all           # whole lookback window

Requires a gated build (customers.json must carry the identity columns) and:

    GOOGLE_SHEET_ID                 the target spreadsheet's id
    GOOGLE_SERVICE_ACCOUNT_JSON     service-account key, raw JSON or a file path

Setup, once:
  1. Google Cloud console -> create a service account -> add a JSON key.
     It needs no IAM roles; access is granted by sharing the Sheet with it.
  2. Enable the Google Sheets API for that project.
  3. Create the Sheet. Share it as Editor with the service account's email
     (client_email in the JSON).
  4. Share it again: "Anyone at solarsquare.in with the link" -> Viewer.
     Do NOT use "Anyone with the link" -- that is public.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from metabase import load_dotenv  # noqa: E402

DATA = os.path.join(ROOT, "web", "data", "customers.json")

# Mirrors EXPORT_COLUMNS in web/js/export.js so the Sheet and the in-browser
# download carry the same fields in the same order.
COLUMNS = [
    ("install_id", "SSEID"),
    ("customer_name", "Name"),
    ("branch", "Cluster"),
    ("city", "City"),
    ("state", "State"),
    ("order_booked_date", "Order Booked Date"),
    ("hoto_date", "HOTO Date"),
    ("sc_name", "SC Name"),
    ("sc_email", "SC Email"),
    ("first_install_date", "Install Date"),
    ("installation_champion", "Installation Champion"),
    ("installation_champion_email", "Installation Champion Email"),
    ("commissioning_date", "Commissioning Date"),
    ("referrer_activated", "Referrer Activation"),
    ("successful_activated", "Orders Activation"),
    ("leads_in_window", "Leads In Window"),
    ("orders_in_window", "Orders In Window"),
    ("activated_by_window", "Sub-Channel"),
    ("activation_window", "Activation Window"),
    ("first_timing_bucket", "First Referral Window"),
    ("days_to_activation", "Days From Install To First Referral"),
    ("capacity_kw", "Capacity kW"),
]

# sc_name now ships in the public build too (the dashboard ranks consultants by
# name), so it no longer distinguishes a gated build. These four still do.
IDENTITY = ("install_id", "customer_name", "sc_email", "installation_champion")


def decode(payload: dict, key: str, i: int):
    col = payload["columns"].get(key)
    if not col:
        return ""
    v = col["v"][i]
    if v is None:
        return ""
    if col["t"] == "cat":
        return col["levels"][v]
    if col["t"] == "bool":
        return "Yes" if v else "No"
    return v


def month_floor(d: date, back: int) -> str:
    y, m = d.year, d.month - back
    while m <= 0:
        m += 12
        y -= 1
    return f"{y:04d}-{m:02d}-01"


def month_end(d: date, back: int) -> str:
    y, m = d.year, d.month - back + 1
    while m > 12:
        m -= 12
        y += 1
    first_next = date(y, m, 1)
    return (first_next - __import__("datetime").timedelta(days=1)).isoformat()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=3,
                    help="how many COMPLETE months back to include (default 3)")
    ap.add_argument("--all", action="store_true", help="whole lookback window")
    ap.add_argument("--worksheet", default="Customers")
    args = ap.parse_args()

    load_dotenv(os.path.join(ROOT, ".env"))
    sheet_id = os.environ.get("GOOGLE_SHEET_ID", "").strip()
    creds_raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if not sheet_id or not creds_raw:
        print("ERROR: set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.\n"
              "       See the setup steps at the top of this file.", file=sys.stderr)
        return 1

    if not os.path.exists(DATA):
        print(f"ERROR: {DATA} not found. Run etl/build.py --mode gated first.", file=sys.stderr)
        return 1
    with open(DATA, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    missing = [k for k in IDENTITY if k not in payload["columns"]]
    if missing:
        print("ERROR: this is a PUBLIC build -- it has no identity columns "
              f"({', '.join(missing)}).\n"
              "       Rebuild with:  python etl/build.py --mode gated", file=sys.stderr)
        return 1

    # --- window -----------------------------------------------------------
    today = date.today()
    if args.all:
        lo, hi = "0000-01-01", "9999-12-31"
        label = "all"
    else:
        lo = month_floor(today, args.months)
        hi = month_end(today, 1)          # last COMPLETE month
        label = f"{lo[:7]}..{hi[:7]}"

    dates = payload["columns"].get("first_install_date")
    rows = []
    for i in range(payload["n"]):
        if dates:
            code = dates["v"][i]
            if code is None:
                continue
            d = dates["levels"][code]
            if d < lo or d > hi:
                continue
        rows.append([decode(payload, key, i) for key, _ in COLUMNS])

    print(f"{len(rows):,} customers installed {label}")

    # --- push -------------------------------------------------------------
    import gspread
    from google.oauth2.service_account import Credentials

    info = json.load(open(creds_raw, encoding="utf-8")) \
        if os.path.exists(creds_raw) else json.loads(creds_raw)
    creds = Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/spreadsheets"])
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(sheet_id)

    try:
        ws = sh.worksheet(args.worksheet)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(args.worksheet, rows=len(rows) + 10, cols=len(COLUMNS))

    header = [c[1] for c in COLUMNS]
    stamp = [[f"Refreshed {datetime.now().strftime('%d %b %Y %H:%M')} IST"
              f"  |  installed {label}  |  {len(rows):,} customers"]]

    ws.clear()
    ws.update(values=stamp + [header] + rows, range_name="A1",
              value_input_option="RAW")
    ws.freeze(rows=2)
    # Derived from COLUMNS: a hardcoded last column silently stops bolding the
    # header the moment a field is added.
    last = chr(ord("A") + len(COLUMNS) - 1) if len(COLUMNS) <= 26 else "AZ"
    ws.format(f"A2:{last}2", {"textFormat": {"bold": True}})

    print(f"Wrote {len(rows):,} rows to '{args.worksheet}' in {sh.title}")
    print(f"  https://docs.google.com/spreadsheets/d/{sheet_id}")
    print("\nCheck sharing is 'Anyone at solarsquare.in with the link' (Viewer),")
    print("NOT 'Anyone with the link' -- this sheet carries customer and staff names.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
