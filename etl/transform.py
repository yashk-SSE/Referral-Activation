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
TIMING_BUCKETS = [
    "Before installation",
    "Install + 0-3 days",
    "Install + 4-7 days",
    "Install + 8 days to commissioning",
    "After commissioning",
]


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
    }


def _blank(value: Any) -> bool:
    return (
        value is None
        or (isinstance(value, float) and math.isnan(value))
        or not str(value).strip()
    )


def derive_sub_channel(
    roles: pd.Series, campaigns: pd.Series, mapping: dict[str, Any]
) -> tuple[pd.Series, Counter]:
    """Resolve each referral to one Sub-Channel, driven by referrer_role.

        Sales    role in Solar Consultant / LRM / Pre sales Team / SC - Referral Calling
        BTL      role = BTL
        Ops/AMC  role in CDM / NPS Sweep Team / Ops(...)
        CApp     role = Customer AND utm_campaign  = customer_app
        Online   role = Customer AND utm_campaign != customer_app
        Others   everything else, including a blank role

    `unmapped` records what landed in Others so the size and shape of that
    bucket is visible rather than assumed.
    """
    unmapped: Counter = Counter()
    role_map = mapping["role"]
    customer_role = mapping["customer_role"]
    capp_campaign = mapping["capp_campaign"]

    def _one(role: Any, campaign: Any) -> str:
        if _blank(role):
            unmapped["(no referrer_role)"] += 1
            return "Others"
        key = _norm(role)
        if key in role_map:
            return role_map[key]
        if key == customer_role:
            return "CApp" if _norm(campaign) == capp_campaign else "Online"
        unmapped[f"role: {str(role).strip()}"] += 1
        return "Others"

    values = [_one(r, c) for r, c in zip(roles, campaigns)]
    return pd.Series(values, index=roles.index), unmapped


# ---------------------------------------------------------------------------
# referral timing
# ---------------------------------------------------------------------------
def assign_timing_bucket(
    ref_date: Any, install_date: Any, commissioning_date: Any
) -> str | None:
    """Which window a referral falls in, relative to the customer's install.

    Commissioning takes precedence over the day-count windows: once a system is
    commissioned the customer is a live user, not someone mid-installation, so
    a referral on day 5 of a system commissioned on day 4 is "After
    commissioning" rather than "Install + 4-7 days". That is the
    "if commissioning happens in between, take commissioning first" rule.
    """
    if pd.isna(ref_date) or pd.isna(install_date):
        return None
    if ref_date < install_date:
        return "Before installation"
    commissioned = not pd.isna(commissioning_date)
    if commissioned and ref_date >= commissioning_date:
        return "After commissioning"
    days = (ref_date - install_date).days
    if days <= 3:
        return "Install + 0-3 days"
    if days <= 7:
        return "Install + 4-7 days"
    return "Install + 8 days to commissioning"


# ---------------------------------------------------------------------------
# core build
# ---------------------------------------------------------------------------
def _to_date(series: pd.Series) -> pd.Series:
    parsed = pd.to_datetime(series, errors="coerce", utc=True)
    return parsed.dt.tz_localize(None).dt.normalize()


def _month_diff(later: pd.Series, earlier: pd.Series) -> pd.Series:
    """Whole calendar months between two date series (can be negative)."""
    return (later.dt.year - earlier.dt.year) * 12 + (later.dt.month - earlier.dt.month)


def build_customer_base(
    installs: pd.DataFrame,
    referrals: pd.DataFrame,
    mapping: dict[str, Any],
    as_of: date,
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
    referrals = referrals.dropna(subset=["referral_date", "referrer_customer_id"])
    referrals["referrer_customer_id"] = referrals["referrer_customer_id"].astype(str)
    for col in ("referrer_role", "utm_campaign"):
        if col not in referrals.columns:
            referrals[col] = None
    referrals["sub_channel"], unmapped = derive_sub_channel(
        referrals["referrer_role"], referrals["utm_campaign"], mapping
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
    installs = installs.sort_values("install_date")
    first = installs.groupby("customer_id", as_index=False).first()
    rollup = installs.groupby("customer_id", as_index=False).agg(
        first_install_date=("install_date", "min"),
        install_count=("install_id", "nunique"),
        capacity_kw=("capacity_kw", "sum"),
        order_value=("order_value", "sum"),
    )
    attrs = [c for c in ("state", "city", "branch", "hoto_date", "commissioning_date")
             if c in first.columns]
    base = rollup.merge(first[["customer_id", *attrs]], on="customer_id", how="left")

    # --- referral timing, which needs the customer's own milestone dates ----
    referrals = referrals.sort_values("referral_date")
    referrals["referral_rank"] = referrals.groupby("referrer_customer_id").cumcount() + 1
    ref = referrals.merge(
        base[["customer_id", "first_install_date", "hoto_date", "commissioning_date"]],
        left_on="referrer_customer_id", right_on="customer_id", how="inner",
    )
    ref["timing_bucket"] = [
        assign_timing_bucket(r, i, c)
        for r, i, c in zip(ref["referral_date"], ref["first_install_date"],
                           ref["commissioning_date"])
    ]
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
        firsts = frame.sort_values("referral_date").groupby(
            "referrer_customer_id", as_index=False).first()
        return firsts[["referrer_customer_id", "sub_channel"]].rename(
            columns={"sub_channel": label})

    agg = agg.merge(_first_sub_channel(ref, "activated_by"),
                    on="referrer_customer_id", how="left")
    agg = agg.merge(_first_sub_channel(ref[ref["is_pre_install"]], "sub_channel_pre"),
                    on="referrer_customer_id", how="left")
    agg = agg.merge(_first_sub_channel(ref[~ref["is_pre_install"]], "sub_channel_post"),
                    on="referrer_customer_id", how="left")

    # timing bucket of the FIRST referral -- what actually activated them
    first_ref = ref.sort_values("referral_date").groupby(
        "referrer_customer_id", as_index=False).first()
    agg = agg.merge(
        first_ref[["referrer_customer_id", "timing_bucket", "days_from_hoto"]].rename(
            columns={"timing_bucket": "first_timing_bucket",
                     "days_from_hoto": "first_tat_from_hoto"}),
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
