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

MAX_TRIANGLE_MONTHS = 24

# Populated from source_map.json at load time so the dashboard and the ETL
# always agree on the bucket list and its order.
CANONICAL_SOURCES: list[str] = []


# ---------------------------------------------------------------------------
# activation source
# ---------------------------------------------------------------------------
def load_source_map(path: str) -> dict[str, Any]:
    """Load the two-stage activation mapping (employee role, then programme)."""
    global CANONICAL_SOURCES
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)

    def flatten(section: str) -> dict[str, str]:
        out: dict[str, str] = {}
        for canonical, raw_values in cfg.get(section, {}).items():
            for raw in raw_values:
                out[str(raw).strip().lower()] = canonical
        return out

    CANONICAL_SOURCES = list(cfg["display_order"])
    return {"role": flatten("role_map"), "source": flatten("source_map")}


def _blank(value: Any) -> bool:
    return (
        value is None
        or (isinstance(value, float) and math.isnan(value))
        or not str(value).strip()
    )


def derive_activation(
    roles: pd.Series, sources: pd.Series, mapping: dict[str, Any]
) -> tuple[pd.Series, Counter]:
    """Resolve each referral to one activation bucket.

    The employee role wins when present, because it says who actually prompted
    the referral. When it is blank no employee was involved, so the programme
    route (source) is what distinguishes a self-serve customer referral from a
    partner or employee one.
    """
    unmapped: Counter = Counter()
    role_map, source_map = mapping["role"], mapping["source"]

    def _one(role: Any, source: Any) -> str:
        if not _blank(role):
            key = str(role).strip().lower()
            if key in role_map:
                return role_map[key]
            unmapped[f"role: {str(role).strip()}"] += 1
            return "Others"
        if not _blank(source):
            key = str(source).strip().lower()
            if key in source_map:
                return source_map[key]
            unmapped[f"source: {str(source).strip()}"] += 1
            return "Others"
        unmapped["(no role, no source)"] += 1
        return "Others"

    values = [_one(r, s) for r, s in zip(roles, sources)]
    return pd.Series(values, index=roles.index), unmapped


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
    source_map: dict[str, str],
    as_of: date,
) -> tuple[pd.DataFrame, pd.DataFrame, Counter]:
    installs = installs.copy()
    referrals = referrals.copy()

    installs["install_date"] = _to_date(installs["install_date"])
    installs = installs.dropna(subset=["install_date", "customer_id"])
    installs["customer_id"] = installs["customer_id"].astype(str)
    for col in ("capacity_kw", "order_value"):
        if col in installs.columns:
            installs[col] = pd.to_numeric(installs[col], errors="coerce")
        else:
            installs[col] = 0.0

    referrals["referral_date"] = _to_date(referrals["referral_date"])
    referrals = referrals.dropna(subset=["referral_date", "referrer_customer_id"])
    referrals["referrer_customer_id"] = referrals["referrer_customer_id"].astype(str)
    for col in ("referrer_role", "referral_source"):
        if col not in referrals.columns:
            referrals[col] = None
    referrals["activation_source"], unmapped = derive_activation(
        referrals["referrer_role"], referrals["referral_source"], source_map
    )

    # --- customer base, cohorted on first install --------------------------
    installs = installs.sort_values("install_date")
    first = installs.groupby("customer_id", as_index=False).first()
    rollup = installs.groupby("customer_id", as_index=False).agg(
        first_install_date=("install_date", "min"),
        last_install_date=("install_date", "max"),
        install_count=("install_id", "nunique"),
        capacity_kw=("capacity_kw", "sum"),
        order_value=("order_value", "sum"),
    )
    attrs = [
        c
        for c in ("state", "city", "branch", "acquisition_channel", "referred_by_customer_id")
        if c in first.columns
    ]
    base = rollup.merge(first[["customer_id", *attrs]], on="customer_id", how="left")

    # --- referral rollup ---------------------------------------------------
    referrals = referrals.sort_values("referral_date")
    referrals["referral_rank"] = referrals.groupby("referrer_customer_id").cumcount() + 1
    if "converted_install_id" in referrals.columns:
        referrals["is_converted"] = referrals["converted_install_id"].notna()
    else:
        referrals["is_converted"] = False

    ref_roll = referrals.groupby("referrer_customer_id", as_index=False).agg(
        first_referral_date=("referral_date", "min"),
        last_referral_date=("referral_date", "max"),
        referrals_total=("referral_id", "nunique"),
        referrals_converted=("is_converted", "sum"),
    )
    firsts = referrals[referrals["referral_rank"] == 1][
        ["referrer_customer_id", "activation_source"]
    ].rename(columns={"activation_source": "activated_by"})
    ref_roll = ref_roll.merge(firsts, on="referrer_customer_id", how="left")

    base = base.merge(
        ref_roll, left_on="customer_id", right_on="referrer_customer_id", how="left"
    ).drop(columns=["referrer_customer_id"], errors="ignore")

    # --- derived fields ----------------------------------------------------
    base["referrals_total"] = base["referrals_total"].fillna(0).astype(int)
    base["referrals_converted"] = base["referrals_converted"].fillna(0).astype(int)
    base["is_referrer"] = base["referrals_total"] > 0
    base["activated_by"] = base["activated_by"].where(base["is_referrer"], None)

    base["cohort_month"] = base["first_install_date"].dt.strftime("%Y-%m")
    as_of_ts = pd.Timestamp(as_of)
    base["maturity_months"] = (
        (as_of_ts.year - base["first_install_date"].dt.year) * 12
        + (as_of_ts.month - base["first_install_date"].dt.month)
    ).clip(lower=0)

    base["months_to_first_referral"] = _month_diff(
        base["first_referral_date"], base["first_install_date"]
    )
    base["days_to_first_referral"] = (
        base["first_referral_date"] - base["first_install_date"]
    ).dt.days
    base["pre_install_referrer"] = base["days_to_first_referral"] < 0
    if "referred_by_customer_id" in base.columns:
        base["was_referred_in"] = base["referred_by_customer_id"].notna()
    else:
        base["was_referred_in"] = False

    base["capacity_band"] = pd.cut(
        base["capacity_kw"].fillna(0),
        bins=[-0.01, 3, 5, 10, 25, 100, float("inf")],
        labels=["<=3 kW", "3-5 kW", "5-10 kW", "10-25 kW", "25-100 kW", "100+ kW"],
    ).astype(str)

    # referral-level frame, enriched with referrer cohort for trajectory views
    ref_detail = referrals.merge(
        base[["customer_id", "cohort_month", "first_install_date", "first_referral_date"]],
        left_on="referrer_customer_id",
        right_on="customer_id",
        how="inner",
    )
    ref_detail["months_since_first_referral"] = _month_diff(
        ref_detail["referral_date"], ref_detail["first_referral_date"]
    )
    ref_detail["months_since_install"] = _month_diff(
        ref_detail["referral_date"], ref_detail["first_install_date"]
    )

    return base, ref_detail, unmapped


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

    # cumulative referrals per referrer, by months since their first referral
    curve: list[float | None] = []
    for m in range(0, 25):
        eligible = referrers[referrers["maturity_months"] >= m]
        if eligible.empty or ref_detail.empty:
            curve.append(None)
            continue
        ids = set(eligible["customer_id"])
        given = ref_detail[
            ref_detail["referrer_customer_id"].isin(ids)
            & (ref_detail["months_since_first_referral"] <= m)
        ]
        curve.append(round(len(given) / len(eligible), 3))

    by_source = []
    for src in CANONICAL_SOURCES:
        grp = referrers[referrers["activated_by"] == src]
        if grp.empty:
            continue
        by_source.append(
            {
                "source": src,
                "referrers": int(len(grp)),
                "avg_referrals": round(float(grp["referrals_total"].mean()), 2),
                "repeat_rate": round(100 * float((grp["referrals_total"] >= 2).mean()), 2),
                "conversion_rate": round(
                    100 * int(grp["referrals_converted"].sum()) / max(int(grp["referrals_total"].sum()), 1),
                    2,
                ),
            }
        )

    return {"depth": depth, "cumulative_per_referrer": curve, "by_source": by_source}


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
        "referrals": int(base["referrals_total"].sum()),
        "referrals_converted": int(base["referrals_converted"].sum()),
        "pre_install_referrers": int(base["pre_install_referrer"].sum()),
        "median_days_to_first": None if median_days is None or pd.isna(median_days) else median_days,
        "unmapped_sources": dict(unmapped.most_common(25)),
    }
