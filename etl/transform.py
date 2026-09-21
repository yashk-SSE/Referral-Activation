"""Turn the two flat Metabase extracts into the dashboard's datasets.

All business logic lives here rather than in SQL, so every cut on the dashboard
derives from one definition of "referrer", "activated", and "cohort".

Grain note: referrals attach to a CUSTOMER, not an installation. A customer with
two installs would double-count their referrals at installation grain, so the
cohort base is one row per customer, cohorted by their FIRST install date.
"""
from __future__ import annotations

import json
import math
from collections import Counter
from datetime import date
from typing import Any

import pandas as pd

# Populated from sub_channel_map.json at load time so the dashboard and the ETL
# always agree on the bucket list and its order.
SUB_CHANNELS: list[str] = []

# Referral timing, relative to the customer's own installation. Commissioning
# always truncates the post-install windows -- see assign_timing_bucket.
# Reporting buckets inside the activation window, plus the two out-of-window
# states. Filled from funnel_config.json at load time.
TIMING_BUCKETS: list[str] = []
BLINDSPOT = "Before window (blindspot)"
AFTER_WINDOW = "After window"


# ---------------------------------------------------------------------------
# sub-channel
# ---------------------------------------------------------------------------
def _norm(value: Any) -> str:
    """Lowercase and strip ALL whitespace.

    Ops appears as 'Ops(Projects/liaising/O&M/Others)',
    'Ops(project/liasing/O&M/others)' and 'Ops ( project/ liaising /O&M
    /others )'. Removing whitespace collapses the spaced variant onto the
    others; the remaining spelling differences are listed explicitly.
    """
    return "".join(str(value).split()).lower()


def load_sub_channel_map(path: str) -> dict[str, Any]:
    global SUB_CHANNELS
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    role_map: dict[str, str] = {}
    for bucket, raw_values in cfg.get("role_map", {}).items():
        for raw in raw_values:
            role_map[_norm(raw)] = bucket
    SUB_CHANNELS = list(cfg["display_order"])
    return {
        "role": role_map,
        "customer_role": _norm(cfg.get("customer_role", "Customer")),
        "capp_campaign": _norm(cfg.get("capp_campaign", "customer_app")),
        "online_sources": {_norm(v) for v in cfg.get("online_sources", [])},
    }


def _blank(value: Any) -> bool:
    return (
        value is None
        or (isinstance(value, float) and math.isnan(value))
        or not str(value).strip()
    )


def derive_sub_channel(
    roles: pd.Series, campaigns: pd.Series, sources: pd.Series,
    mapping: dict[str, Any]
) -> tuple[pd.Series, Counter]:
    """Resolve each referral to one Sub-Channel.

        Sales    role in Solar Consultant / LRM / Pre sales Team / SC - Referral Calling
        BTL      role = BTL
        Ops/AMC  role in CDM / NPS Sweep Team / Ops(...)
        CApp     role = Customer AND utm_campaign  = customer_app
        Online   role = Customer AND utm_campaign != customer_app, OR
                 role BLANK AND source in online_sources
        Others   everything else

    The second Online arm is what captures customer-initiated referrals.
    referrer_role is populated only when an employee took the referral -- it is
    100% collinear with referrer_email -- so a blank role on an Existing Cx
    referral means the customer raised it themselves.

    `unmapped` records what still lands in Others, so that bucket's size and
    shape stay visible rather than assumed.
    """
    unmapped: Counter = Counter()
    role_map = mapping["role"]
    customer_role = mapping["customer_role"]
    capp_campaign = mapping["capp_campaign"]
    online_sources = mapping.get("online_sources", set())

    def _one(role: Any, campaign: Any, source: Any) -> str:
        if _blank(role):
            if not _blank(source) and _norm(source) in online_sources:
                return "Online"
            unmapped["(no referrer_role)"] += 1
            return "Others"
        key = _norm(role)
        if key in role_map:
            return role_map[key]
        if key == customer_role:
            return "CApp" if _norm(campaign) == capp_campaign else "Online"
        unmapped[f"role: {str(role).strip()}"] += 1
        return "Others"

    values = [_one(r, c, s) for r, c, s in zip(roles, campaigns, sources)]
    return pd.Series(values, index=roles.index), unmapped


def derive_sub_channel_detail(
    sub_channels: pd.Series, roles: pd.Series, sources: pd.Series,
    campaigns: pd.Series
) -> pd.Series:
    """Second level of detail for Online and Others.

    Others is a quarter of all referrers and is not one population: it mixes
    customer self-serve referrals, SolarPro partners, employee referrals, and
    employee-mediated referrals where the role simply was not captured. Those
    warrant different actions, so the breakdown is carried rather than left as
    a single opaque bucket.

    Returns None for anything not in Others.
    """
    def _one(bucket: Any, role: Any, source: Any, campaign: Any) -> str | None:
        if bucket == "Online":
            # Whether marketing prompted it changes what you would do about it,
            # and the two halves convert very differently.
            if not _blank(role):
                return "Customer app / in-app"
            return ("Campaign-driven" if not _blank(campaign) else "Unprompted")
        if bucket != "Others":
            return None
        if not _blank(role):
            # A role that exists but is unmapped -- name it rather than hide it.
            return str(role).strip()
        if _blank(source):
            return "Unattributed (no role, no source)"
        key = _norm(source)
        if "spp" in key:
            return "SolarPro Partner (SPP)"
        if "sseemp" in key:
            return "SSE employee"
        if "existingcxviaemp" in key:
            return "Employee-led, role not captured"
        if "assure" in key:
            return "Assure customer"
        return f"Source: {str(source).strip()}"

    return pd.Series(
        [_one(b, r, s, c)
         for b, r, s, c in zip(sub_channels, roles, sources, campaigns)],
        index=sub_channels.index,
    )


# ---------------------------------------------------------------------------
# referral timing
# ---------------------------------------------------------------------------
def load_activation_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Resolve the activation window and publish its bucket labels."""
    global TIMING_BUCKETS
    act = cfg.get("activation", {})
    subs = act.get("sub_windows", [])
    TIMING_BUCKETS = [BLINDSPOT] + [w["label"] for w in subs] + [AFTER_WINDOW]
    return {
        "start": act.get("window_start_days", -3),
        "end": act.get("window_end_days", 90),
        "sub_windows": subs,
    }


def assign_timing_bucket(
    ref_date: Any, install_date: Any, commissioning_date: Any, act: dict[str, Any]
) -> str | None:
    """Which activation sub-window a referral falls in.

    Days are measured from INSTALLATION, so -3 means three days before it.

    Anything earlier than the window start is the blindspot: those referrals
    predate the customer having a working system and carry too much noise to
    attribute, so they are excluded from every activation metric.

    The final sub-window is capped at commissioning where the config says so --
    once commissioned the customer is a live user, not someone mid-installation,
    so a referral after commissioning is out of that bucket even if it is still
    inside the day range.
    """
    if pd.isna(ref_date) or pd.isna(install_date):
        return None
    days = (ref_date - install_date).days
    if days < act["start"]:
        return BLINDSPOT
    if days > act["end"]:
        return AFTER_WINDOW

    commissioned = not pd.isna(commissioning_date)
    comm_days = (commissioning_date - install_date).days if commissioned else None

    for w in act["sub_windows"]:
        lo = w.get("start")
        hi = w.get("end")
        if hi is None:
            hi = act["end"]
        if w.get("cap_at_commissioning") and comm_days is not None:
            hi = min(hi, comm_days)
        if lo <= days <= hi:
            return w["label"]
    # Past the last sub-window but still inside the overall window -- that is
    # what "or commissioning, whichever comes first" leaves behind.
    return AFTER_WINDOW


# ---------------------------------------------------------------------------
# core build
# ---------------------------------------------------------------------------
def _to_date(series: pd.Series) -> pd.Series:
    parsed = pd.to_datetime(series, errors="coerce", utc=True)
    return parsed.dt.tz_localize(None).dt.normalize()


def _month_diff(later: pd.Series, earlier: pd.Series) -> pd.Series:
    """Whole calendar months between two date series (can be negative)."""
    return (later.dt.year - earlier.dt.year) * 12 + (later.dt.month - earlier.dt.month)


def load_funnel_config(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    return {k: v for k, v in cfg.items() if not k.startswith("_")}


def attach_funnel(
    base: pd.DataFrame,
    installs: pd.DataFrame,
    nps: pd.DataFrame | None,
    idv: pd.DataFrame | None,
    cfg: dict[str, Any],
) -> pd.DataFrame:
    """Cx Recommended and IDV.

    Both are PLACEHOLDERS until a source is agreed. When disabled the columns
    are all-null rather than all-false, so the dashboard can render a dash
    instead of a zero -- "we have no source" and "we did none" are different
    statements and a zero would assert the wrong one.
    """
    if not cfg.get("cx_recommended", {}).get("enabled"):
        base["nps_answered"] = pd.NA
        base["cx_recommended"] = pd.NA
        base["nps_score"] = pd.NA
        nps = None
    if not cfg.get("idv", {}).get("enabled"):
        base["idv_done"] = pd.NA
        base["idv_count"] = pd.NA
        idv = None
    if nps is None and idv is None:
        return base
    return _attach_funnel_live(base, installs, nps, idv, cfg)


def _attach_funnel_live(
    base: pd.DataFrame,
    installs: pd.DataFrame,
    nps: pd.DataFrame | None,
    idv: pd.DataFrame | None,
    cfg: dict[str, Any],
) -> pd.DataFrame:
    """Add the Cx Recommended and IDV stages to the customer base.

    Both are measured per SSEID but the base is per customer, so a customer
    counts as recommending / visited if ANY of their projects did. In practice
    almost every customer has one project.

    Coverage is carried separately from outcome (`nps_answered` vs
    `cx_recommended`), because the two mean very different things: today only
    8.1% of the base has answered the survey at all, while 91.5% of those who
    did are promoters. Collapsing them would read as "customers will not
    recommend us" when it actually says "we did not ask most of them".
    """
    rec_cfg = cfg.get("cx_recommended", {})
    idv_cfg = cfg.get("idv", {})
    min_score = rec_cfg.get("min_score", 9)
    days_before = idv_cfg.get("days_before", 3)
    days_after = idv_cfg.get("days_after", 3)

    # --- Cx Recommended -----------------------------------------------------
    base["nps_answered"] = False
    base["cx_recommended"] = False
    base["nps_score"] = pd.NA
    if nps is not None and not nps.empty and "install_id" in installs.columns:
        scored = installs[["customer_id", "install_id"]].merge(
            nps[["install_id", "nps_score"]], on="install_id", how="inner")
        scored["nps_score"] = pd.to_numeric(scored["nps_score"], errors="coerce")
        per_cust = scored.groupby("customer_id", as_index=False)["nps_score"].max()
        base = base.drop(columns=["nps_score"]).merge(per_cust, on="customer_id", how="left")
        base["nps_answered"] = base["nps_score"].notna()
        base["cx_recommended"] = base["nps_score"] >= min_score

    # --- IDV ----------------------------------------------------------------
    base["idv_done"] = False
    base["idv_count"] = 0
    if idv is not None and not idv.empty:
        v = idv.copy()
        v["visit_date"] = _to_date(v["visit_date"])
        v = v.dropna(subset=["visit_date", "customer_id"])
        v["customer_id"] = v["customer_id"].astype(str)
        v = v.merge(base[["customer_id", "first_install_date"]], on="customer_id", how="inner")
        delta = (v["visit_date"] - v["first_install_date"]).dt.days
        v = v[(delta >= -days_before) & (delta <= days_after)]
        if not v.empty:
            counts = v.groupby("customer_id", as_index=False).agg(
                idv_count=("visit_id", "nunique"))
            base = base.drop(columns=["idv_count"]).merge(counts, on="customer_id", how="left")
            base["idv_count"] = base["idv_count"].fillna(0).astype(int)
            base["idv_done"] = base["idv_count"] > 0

    return base


def funnel_summary(base: pd.DataFrame, cfg: dict[str, Any], act: dict[str, Any]) -> dict:
    """Stage-by-stage funnel. Disabled stages report customers=None, not 0."""
    n = len(base)
    rec_on = bool(cfg.get("cx_recommended", {}).get("enabled"))
    idv_on = bool(cfg.get("idv", {}).get("enabled"))

    def block(col: str, label: str, enabled: bool = True) -> dict:
        if not enabled or col not in base.columns:
            return {"stage": label, "customers": None, "pct_of_base": None,
                    "placeholder": True}
        count = int(base[col].fillna(False).astype(bool).sum())
        return {"stage": label, "customers": count,
                "pct_of_base": round(100 * count / n, 2) if n else 0.0}

    return {
        "stages": [
            {"stage": "Installed", "customers": n, "pct_of_base": 100.0},
            block("cx_recommended", "Cx Recommended", rec_on),
            block("idv_done", "IDV done", idv_on),
            block("referrer_activated", "Referrer activated"),
            block("successful_activated", "Successful referrer activated"),
        ],
        "config": {
            "cx_recommended_enabled": rec_on,
            "idv_enabled": idv_on,
            "window_start_days": act["start"],
            "window_end_days": act["end"],
            "sub_windows": [w["label"] for w in act["sub_windows"]],
        },
    }


def city_table(base: pd.DataFrame, dim: str = "city") -> list[dict]:
    """The Sales tracking table: one row per city, plus an India total.

    Activation counts use the window, not lifetime referral, so this table and
    the funnel agree. Cx Recommended and IDV are None while they are
    placeholders.
    """
    def row(frame: pd.DataFrame, label: str) -> dict:
        n = len(frame)
        act = int(frame["referrer_activated"].sum())
        suc = int(frame["successful_activated"].sum())
        leads = int(frame["leads_in_window"].sum())
        orders = int(frame["orders_in_window"].sum())
        has_rec = frame["cx_recommended"].notna().any() if "cx_recommended" in frame else False
        has_idv = frame["idv_done"].notna().any() if "idv_done" in frame else False
        return {
            "name": label,
            "installed": n,
            "cx_recommended": int(frame["cx_recommended"].fillna(False).sum()) if has_rec else None,
            "idv": int(frame["idv_done"].fillna(False).sum()) if has_idv else None,
            "referrer_activated": act,
            "successful_activated": suc,
            "leads": leads,
            "orders": orders,
            "activation_rate": round(100 * act / n, 2) if n else 0.0,
            "leads_per_referrer": round(leads / act, 2) if act else 0.0,
            "orders_per_referrer": round(orders / act, 2) if act else 0.0,
        }

    rows = [row(base, "India (all)")]
    if dim in base.columns:
        for key in sorted(x for x in base[dim].dropna().unique()):
            rows.append(row(base[base[dim] == key], str(key)))
    return rows


def build_customer_base(
    installs: pd.DataFrame,
    referrals: pd.DataFrame,
    mapping: dict[str, Any],
    as_of: date,
    act: dict[str, Any] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, Counter]:
    installs = installs.copy()
    referrals = referrals.copy()

    for col in ("install_date", "hoto_date", "commissioning_date"):
        installs[col] = _to_date(installs[col]) if col in installs.columns else pd.NaT
    installs = installs.dropna(subset=["install_date", "customer_id"])
    installs["customer_id"] = installs["customer_id"].astype(str)
    for col in ("capacity_kw", "order_value"):
        installs[col] = pd.to_numeric(installs.get(col), errors="coerce")

    referrals["referral_date"] = _to_date(referrals["referral_date"])
    # Order on the real timestamp, falling back to the date when absent, with
    # referral_id as a final tie-break so the result is reproducible run to run.
    referrals["referral_ts"] = pd.to_datetime(
        referrals.get("referral_ts"), errors="coerce"
    ).fillna(referrals["referral_date"]) if "referral_ts" in referrals.columns         else referrals["referral_date"]
    referrals = referrals.dropna(subset=["referral_date", "referrer_customer_id"])
    referrals["referrer_customer_id"] = referrals["referrer_customer_id"].astype(str)
    for col in ("referrer_role", "utm_campaign", "referral_source"):
        if col not in referrals.columns:
            referrals[col] = None
    referrals["sub_channel"], unmapped = derive_sub_channel(
        referrals["referrer_role"], referrals["utm_campaign"],
        referrals["referral_source"], mapping
    )
    referrals["sub_channel_detail"] = derive_sub_channel_detail(
        referrals["sub_channel"], referrals["referrer_role"],
        referrals["referral_source"], referrals["utm_campaign"]
    )
    if "converted_date" in referrals.columns:
        referrals["converted_date"] = _to_date(referrals["converted_date"])
    else:
        referrals["converted_date"] = pd.NaT
    referrals["is_converted"] = (
        referrals["converted_install_id"].notna()
        if "converted_install_id" in referrals.columns
        else False
    )

    # --- customer base, cohorted on FIRST installation ---------------------
    installs = installs.sort_values("install_date", kind="mergesort")
    # drop_duplicates, not groupby().first(): groupby().first() skips nulls
    # PER COLUMN, so it can splice a later project's HOTO date onto the first
    # project's row. We want the first project's row exactly as it stands.
    first = installs.drop_duplicates(subset="customer_id", keep="first")
    rollup = installs.groupby("customer_id", as_index=False).agg(
        first_install_date=("install_date", "min"),
        install_count=("install_id", "nunique"),
        capacity_kw=("capacity_kw", "sum"),
        order_value=("order_value", "sum"),
    )
    attrs = [c for c in ("install_id", "state", "city", "branch",
                         "hoto_date", "commissioning_date",
                         "customer_name", "order_booked_date", "sc_name", "sc_email",
                         "installation_champion", "installation_champion_email")
             if c in first.columns]
    base = rollup.merge(first[["customer_id", *attrs]], on="customer_id", how="left")

    # --- referral timing, which needs the customer's own milestone dates ----
    referrals = referrals.sort_values(["referral_ts", "referral_id"], kind="mergesort")
    referrals["referral_rank"] = referrals.groupby("referrer_customer_id").cumcount() + 1
    ref = referrals.merge(
        base[["customer_id", "first_install_date", "hoto_date", "commissioning_date"]],
        left_on="referrer_customer_id", right_on="customer_id", how="inner",
    )
    act = act or {"start": -3, "end": 90, "sub_windows": []}
    ref["timing_bucket"] = [
        assign_timing_bucket(r, i, c, act)
        for r, i, c in zip(ref["referral_date"], ref["first_install_date"],
                           ref["commissioning_date"])
    ]
    # The blindspot rule: referrals before the window start are noise and take
    # no part in any activation metric.
    ref["in_window"] = ref["timing_bucket"].notna() & (ref["timing_bucket"] != BLINDSPOT)                        & (ref["timing_bucket"] != AFTER_WINDOW)
    ref["is_pre_install"] = ref["referral_date"] < ref["first_install_date"]
    ref["days_from_install"] = (ref["referral_date"] - ref["first_install_date"]).dt.days
    # TAT for pre-installation referrals is measured from HOTO, not from install.
    ref["days_from_hoto"] = (ref["referral_date"] - ref["hoto_date"]).dt.days
    ref.loc[~ref["is_pre_install"], "days_from_hoto"] = pd.NA

    # --- roll referrals back up to the customer ----------------------------
    agg = ref.groupby("referrer_customer_id", as_index=False).agg(
        first_referral_date=("referral_date", "min"),
        last_referral_date=("referral_date", "max"),
        referrals_total=("referral_id", "nunique"),
        referrals_converted=("is_converted", "sum"),
    )

    def _first_sub_channel(frame: pd.DataFrame, label: str) -> pd.DataFrame:
        """Sub-Channel of the earliest referral in `frame`, per customer."""
        if frame.empty:
            return pd.DataFrame(columns=["referrer_customer_id", label])
        firsts = frame.sort_values(
            ["referral_ts", "referral_id"], kind="mergesort"
        ).drop_duplicates(subset="referrer_customer_id", keep="first")
        return firsts[["referrer_customer_id", "sub_channel"]].rename(
            columns={"sub_channel": label})

    agg = agg.merge(_first_sub_channel(ref, "activated_by"),
                    on="referrer_customer_id", how="left")
    agg = agg.merge(_first_sub_channel(ref[ref["is_pre_install"]], "sub_channel_pre"),
                    on="referrer_customer_id", how="left")
    agg = agg.merge(_first_sub_channel(ref[~ref["is_pre_install"]], "sub_channel_post"),
                    on="referrer_customer_id", how="left")

    # timing bucket of the FIRST referral -- what actually activated them
    # Same reason as above: sub_channel_detail is null whenever the referral is not
    # in the Others Sub-Channel, and groupby().first() would skip past those
    # nulls to a later referral -- overstating Others by ~30%.
    first_ref = ref.sort_values(
        ["referral_ts", "referral_id"], kind="mergesort"
    ).drop_duplicates(subset="referrer_customer_id", keep="first")
    agg = agg.merge(
        first_ref[["referrer_customer_id", "timing_bucket", "days_from_hoto",
                   "sub_channel_detail"]].rename(
            columns={"timing_bucket": "first_timing_bucket",
                     "days_from_hoto": "first_tat_from_hoto",
                     "sub_channel_detail": "sub_channel_detail"}),
        on="referrer_customer_id", how="left")

    # --- activation, from in-window referrals only -------------------------
    win = ref[ref["in_window"]]
    act_agg = win.groupby("referrer_customer_id", as_index=False).agg(
        leads_in_window=("referral_id", "nunique"),
        orders_in_window=("is_converted", "sum"),
        first_activation_date=("referral_date", "min"),
    )
    agg = agg.merge(act_agg, on="referrer_customer_id", how="left")
    agg = agg.merge(_first_sub_channel(win, "activated_by_window"),
                    on="referrer_customer_id", how="left")

    # Which window the first IN-WINDOW referral landed in. NOT the same as
    # first_timing_bucket: a customer whose very first referral fell in the
    # blindspot can still activate later, and first_timing_bucket then places
    # them outside the window entirely -- so splitting activated customers by
    # first_timing_bucket silently loses every one of them.
    first_win = win.sort_values(
        ["referral_ts", "referral_id"], kind="mergesort"
    ).drop_duplicates(subset="referrer_customer_id", keep="first")
    agg = agg.merge(
        first_win[["referrer_customer_id", "timing_bucket"]].rename(
            columns={"timing_bucket": "activation_window"}),
        on="referrer_customer_id", how="left")

    base = base.merge(agg, left_on="customer_id", right_on="referrer_customer_id",
                      how="left").drop(columns=["referrer_customer_id"], errors="ignore")

    # --- derived flags -----------------------------------------------------
    base["referrals_total"] = base["referrals_total"].fillna(0).astype(int)
    base["referrals_converted"] = base["referrals_converted"].fillna(0).astype(int)
    base["is_referrer"] = base["referrals_total"] > 0
    # "Successful referrer" = at least one referral that became an order.
    base["is_successful_referrer"] = base["referrals_converted"] > 0
    base["activated_by"] = base["activated_by"].where(base["is_referrer"], None)

    # --- activation flags (the metrics Sales is tracked on) ----------------
    base["leads_in_window"] = base["leads_in_window"].fillna(0).astype(int)
    base["orders_in_window"] = base["orders_in_window"].fillna(0).astype(int)
    base["referrer_activated"] = base["leads_in_window"] > 0
    base["successful_activated"] = base["orders_in_window"] > 0
    base["activated_by_window"] = base["activated_by_window"].where(
        base["referrer_activated"], None)
    base["activation_window"] = base["activation_window"].where(
        base["referrer_activated"], None)
    base["days_to_activation"] = (
        base["first_activation_date"] - base["first_install_date"]).dt.days

    base["cohort_month"] = base["first_install_date"].dt.strftime("%Y-%m")
    as_of_ts = pd.Timestamp(as_of)
    base["maturity_months"] = (
        (as_of_ts.year - base["first_install_date"].dt.year) * 12
        + (as_of_ts.month - base["first_install_date"].dt.month)
    ).clip(lower=0)

    base["months_to_first_referral"] = _month_diff(
        base["first_referral_date"], base["first_install_date"])
    base["days_to_first_referral"] = (
        base["first_referral_date"] - base["first_install_date"]).dt.days
    base["pre_install_referrer"] = base["days_to_first_referral"] < 0
    base["first_tat_from_hoto"] = pd.to_numeric(base["first_tat_from_hoto"],
                                                errors="coerce")

    base["capacity_band"] = pd.cut(
        base["capacity_kw"].fillna(0),
        bins=[-0.01, 3, 5, 10, 25, 100, float("inf")],
        labels=["<=3 kW", "3-5 kW", "5-10 kW", "10-25 kW", "25-100 kW", "100+ kW"],
    ).astype(str)

    return base, ref, unmapped

# ---------------------------------------------------------------------------
# aggregates
# ---------------------------------------------------------------------------
def cohort_triangle(base: pd.DataFrame) -> dict:
    """Cumulative activation % by cohort month x months since install.

    Cells beyond a cohort's maturity are left null, so a 2-month-old cohort is
    never compared against a 2-year-old one on incomplete data.
    """
    cohorts = sorted(c for c in base["cohort_month"].dropna().unique())
    rows = []
    for cohort in cohorts:
        slice_ = base[base["cohort_month"] == cohort]
        size = len(slice_)
        maturity = int(slice_["maturity_months"].max()) if size else 0
        mtf = slice_["months_to_first_referral"]
        cells: list[float | None] = []
        for m in range(0, MAX_TRIANGLE_MONTHS + 1):
            if m > maturity:
                cells.append(None)
                continue
            activated = int((mtf <= m).sum())
            cells.append(round(100 * activated / size, 2) if size else None)
        rows.append(
            {
                "cohort": cohort,
                "size": size,
                "maturity": maturity,
                "referrers": int(slice_["is_referrer"].sum()),
                "cells": cells,
            }
        )
    return {"months": list(range(0, MAX_TRIANGLE_MONTHS + 1)), "rows": rows}


def trajectory(base: pd.DataFrame, ref_detail: pd.DataFrame) -> dict:
    """How far referrers go after their first referral."""
    referrers = base[base["is_referrer"]]
    total = len(referrers)
    depth = [
        {
            "n": n,
            "customers": int((referrers["referrals_total"] >= n).sum()),
            "pct_of_referrers": (
                round(100 * float((referrers["referrals_total"] >= n).mean()), 2) if total else 0.0
            ),
        }
        for n in range(1, 11)
    ]

    by_source = []
    for src in SUB_CHANNELS:
        grp = referrers[referrers["activated_by"] == src]
        if grp.empty:
            continue
        by_source.append(
            {
                "sub_channel": src,
                "referrers": int(len(grp)),
                "successful": int(grp["is_successful_referrer"].sum()),
                "avg_referrals": round(float(grp["referrals_total"].mean()), 2),
                "repeat_rate": round(100 * float((grp["referrals_total"] >= 2).mean()), 2),
                "conversion_rate": round(
                    100 * int(grp["referrals_converted"].sum()) / max(int(grp["referrals_total"].sum()), 1),
                    2,
                ),
            }
        )

    return {"depth": depth, "by_sub_channel": by_source}


def summarise(base: pd.DataFrame, unmapped: Counter) -> dict:
    referrers = base[base["is_referrer"]]
    median_days = (
        float(referrers["days_to_first_referral"].median()) if len(referrers) else None
    )
    return {
        "customers": int(len(base)),
        "installs": int(base["install_count"].sum()),
        "referrers": int(len(referrers)),
        "activation_rate": round(100 * len(referrers) / len(base), 2) if len(base) else 0.0,
        # A "successful referrer" gave at least one referral that became an order.
        "successful_referrers": int(base["is_successful_referrer"].sum()),
        "success_rate": round(100 * int(base["is_successful_referrer"].sum()) / len(base), 2)
                        if len(base) else 0.0,
        "referrals": int(base["referrals_total"].sum()),
        "referrals_converted": int(base["referrals_converted"].sum()),
        "pre_install_referrers": int(base["pre_install_referrer"].sum()),
        "median_days_to_first": None if median_days is None or pd.isna(median_days) else median_days,
        "unmapped_sources": dict(unmapped.most_common(25)),
    }


# ---------------------------------------------------------------------------
# timing / TAT
# ---------------------------------------------------------------------------
def timing_summary(base: pd.DataFrame, ref: pd.DataFrame) -> dict:
    """Referral timing buckets, sub-channel splits, and pre-install TAT.

    Counted two ways because they answer different questions:
      customers -- where each referrer's FIRST referral landed (what activated
                   them), so the buckets sum to the referrer count
      referrals -- where every referral landed, so a customer who referred both
                   before and after installation appears in both
    """
    referrers = base[base["is_referrer"]]

    by_first = (
        referrers["first_timing_bucket"].value_counts().to_dict()
        if "first_timing_bucket" in referrers.columns else {}
    )
    by_all = ref["timing_bucket"].value_counts().to_dict() if not ref.empty else {}
    total_first = sum(by_first.values())
    total_all = sum(by_all.values())

    buckets = [
        {
            "bucket": b,
            "customers": int(by_first.get(b, 0)),
            "customers_pct": round(100 * by_first.get(b, 0) / total_first, 2) if total_first else 0.0,
            "referrals": int(by_all.get(b, 0)),
            "referrals_pct": round(100 * by_all.get(b, 0) / total_all, 2) if total_all else 0.0,
        }
        for b in TIMING_BUCKETS
    ]

    # Pre-installation TAT is measured from HOTO, per spec.
    pre = ref[ref["is_pre_install"] & ref["days_from_hoto"].notna()]
    tat = pd.to_numeric(pre["days_from_hoto"], errors="coerce").dropna()
    tat_by_channel = []
    for ch in SUB_CHANNELS:
        vals = pd.to_numeric(
            pre.loc[pre["sub_channel"] == ch, "days_from_hoto"], errors="coerce"
        ).dropna()
        if vals.empty:
            continue
        tat_by_channel.append({
            "sub_channel": ch,
            "n": int(len(vals)),
            "p50": round(float(vals.quantile(0.50)), 1),
            "p90": round(float(vals.quantile(0.90)), 1),
        })

    return {
        "buckets": buckets,
        "pre_install_tat_from_hoto": {
            "n": int(len(tat)),
            "p50": round(float(tat.quantile(0.50)), 1) if len(tat) else None,
            "p90": round(float(tat.quantile(0.90)), 1) if len(tat) else None,
            "by_sub_channel": tat_by_channel,
        },
        # Sub-Channel of a customer's first referral BEFORE vs AFTER installation.
        # A customer can appear in both columns.
        "sub_channel_pre": (
            referrers["sub_channel_pre"].value_counts().to_dict()
            if "sub_channel_pre" in referrers.columns else {}
        ),
        "sub_channel_post": (
            referrers["sub_channel_post"].value_counts().to_dict()
            if "sub_channel_post" in referrers.columns else {}
        ),
    }
