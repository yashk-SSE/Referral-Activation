"""Synthetic data matching docs/DATA_CONTRACT.md exactly.

Lets the dashboard be built and reviewed before the real Metabase schema is
wired up. Swapping in real extracts is a flag change, not a rewrite -- the
column contract is identical.

The generator deliberately bakes in the patterns the dashboard has to be able
to SHOW, so that a broken chart is visible as a flat line rather than hiding in
uniform noise:
  - activation rate decays with cohort age (young cohorts look worse)
  - Ops/AMC activates late, BTL activates in bursts, CApp is growing over time
  - a minority of referrers are repeat referrers (heavy tail)
  - some customers refer BEFORE their own install completes
"""
from __future__ import annotations

import random
from datetime import date, timedelta

import pandas as pd

STATES = {
    "Maharashtra": ["Mumbai", "Pune", "Nashik", "Nagpur"],
    "Gujarat": ["Ahmedabad", "Surat", "Vadodara", "Rajkot"],
    "Rajasthan": ["Jaipur", "Jodhpur", "Udaipur"],
    "Uttar Pradesh": ["Lucknow", "Noida", "Kanpur"],
    "Karnataka": ["Bengaluru", "Mysuru"],
    "Haryana": ["Gurugram", "Faridabad"],
}
ACQUISITION = ["Online", "Sales", "BTL", "Referral", "Channel Partner"]
# Mirrors the real warehouse shape: an employee role is present only when an
# employee mediated the referral; otherwise the programme source carries it.
RAW_ROLES = {
    "Sales": ["Solar Consultant", "LRM", "Pre sales Team"],
    "Ops/AMC": ["Ops(Projects/liaising/O&M/Others)", "NPS Sweep Team"],
    "BTL": ["BTL"],
    "Others": ["HO Team & Others"],
}
MEDIATED_SOURCE = "Referral - Existing Cx via Emp"
DIRECT_SOURCE = "Referral - Existing Cx"
STATUSES = ["new", "contacted", "site_visit", "quoted", "won", "lost"]


def generate(n_customers: int = 9000, months: int = 24, seed: int = 7) -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = random.Random(seed)
    today = date.today()
    window_start = today - timedelta(days=months * 30)

    installs = []
    referrals = []
    ref_id = 0

    for cid in range(1, n_customers + 1):
        customer_id = f"CUST{cid:06d}"
        offset = rng.randint(0, months * 30)
        install_date = window_start + timedelta(days=offset)
        age_months = (today.year - install_date.year) * 12 + (today.month - install_date.month)

        state = rng.choice(list(STATES))
        city = rng.choice(STATES[state])
        branch = f"{city} - {rng.choice(['North', 'South', 'Central'])}"
        capacity = round(rng.choice([2, 3, 3, 5, 5, 5, 8, 10, 15, 30, 75]) * rng.uniform(0.9, 1.2), 2)

        n_installs = 1 if rng.random() > 0.06 else 2
        for k in range(n_installs):
            d = install_date + timedelta(days=0 if k == 0 else rng.randint(60, 400))
            if d > today:
                continue
            installs.append(
                {
                    "install_id": f"INS{cid:06d}{k}",
                    "customer_id": customer_id,
                    "install_date": d.isoformat(),
                    "booking_date": (d - timedelta(days=rng.randint(20, 90))).isoformat(),
                    "state": state,
                    "city": city,
                    "branch": branch,
                    "acquisition_channel": rng.choices(ACQUISITION, weights=[35, 30, 12, 18, 5])[0],
                    "capacity_kw": capacity,
                    "order_value": round(capacity * rng.uniform(42000, 58000), 0),
                    "referred_by_customer_id": (
                        f"CUST{rng.randint(1, max(cid - 1, 1)):06d}" if rng.random() < 0.18 and cid > 1 else None
                    ),
                }
            )

        # --- does this customer ever refer? ---------------------------------
        # Older cohorts have had more time, and big systems refer more.
        base_p = 0.17 + min(age_months, 18) * 0.007 + (0.05 if capacity > 10 else 0)
        if state in ("Gujarat", "Rajasthan"):
            base_p += 0.04  # deliberate geographic variation for the geo cut
        if rng.random() > base_p:
            continue

        # Which channel activated them, with a time-varying mix:
        # CApp grows over the window, BTL is lumpy, Ops/AMC skews late.
        recency = 1 - (age_months / max(months, 1))
        weights = {
            "Sales": 50,
            "Ops/AMC": 10,
            "BTL": 7 + (8 if install_date.month in (3, 10, 11) else 0),
            "Customer direct": 10 + 22 * recency,
            "Others": 4,
        }
        source = rng.choices(list(weights), weights=list(weights.values()))[0]

        # Real data peaks just BEFORE commissioning: referrals happen during the
        # sale and installation, not months after handover.
        if source == "Ops/AMC":
            lag = rng.randint(60, 420)
        elif rng.random() < 0.58:
            lag = -rng.randint(1, 120)
        else:
            lag = rng.randint(0, 240)

        first_ref = install_date + timedelta(days=lag)
        if first_ref > today:
            continue

        # Heavy tail: most give one, a few give many.
        n_refs = rng.choices([1, 2, 3, 4, 6, 9], weights=[54, 22, 11, 7, 4, 2])[0]
        when = first_ref
        for j in range(n_refs):
            if when > today:
                break
            ref_id += 1
            converted = rng.random() < (0.34 if source in ("Sales", "Ops/AMC") else 0.22)
            conv_date = when + timedelta(days=rng.randint(30, 120)) if converted else None
            if conv_date and conv_date > today:
                conv_date, converted = None, False
            referrals.append(
                {
                    "referral_id": f"REF{ref_id:07d}",
                    "referrer_customer_id": customer_id,
                    "referral_date": when.isoformat(),
                    # first referral carries the activating source; later ones drift
                    "referrer_role": (
                        rng.choice(RAW_ROLES[source])
                        if source in RAW_ROLES and j == 0 else None
                    ),
                    "referral_source": (
                        DIRECT_SOURCE if source == "Customer direct" else MEDIATED_SOURCE
                    ),
                    "status": "won" if converted else rng.choice(STATUSES[:-1]),
                    "converted_install_id": f"INS-CONV-{ref_id:07d}" if converted else None,
                    "converted_date": conv_date.isoformat() if conv_date else None,
                }
            )
            when = when + timedelta(days=rng.randint(25, 200))

    return pd.DataFrame(installs), pd.DataFrame(referrals)
