/* Decode the column-oriented payload and compute every cut in the browser.
 *
 * All six views aggregate from the same row set, so a filter applied anywhere
 * reshapes all of them consistently. At <=25k customers this is well under a
 * frame's work, so there is no reason to precompute cuts server-side and risk
 * them drifting apart.
 */
'use strict';

/* Populated from meta.json at load time so the bucket list always matches
 * etl/source_map.json -- the buckets are derived from the warehouse's own
 * values, not a fixed guess. */
let SOURCES = ['Sales', 'Online', 'CApp', 'BTL', 'Ops/AMC', 'Others'];
let TIMING_BUCKETS = [
  'Before installation', 'Install + 0-3 days', 'Install + 4-7 days',
  'Install + 8 days to commissioning', 'After commissioning'
];
const SOURCE_COLOR = {
  'Sales': '#3b6fd4',
  'Online': '#17a2a2',
  'CApp': '#8b5cf6',
  'BTL': '#e0862c',
  'Ops/AMC': '#d4506b',
  'Others': '#94a3b8'
};
const TIMING_COLOR = {
  'Before installation': '#e0862c',
  'Install + 0-3 days': '#3b6fd4',
  'Install + 4-7 days': '#5b8ae0',
  'Install + 8 days to commissioning': '#8aaded',
  'After commissioning': '#17a2a2'
};
const FALLBACK_COLOR = '#94a3b8';

const DS = {
  n: 0,
  cols: {},
  meta: {},

  /** Raw integer code for categoricals (fast path for filtering). */
  code(name, i) { return this.cols[name].v[i]; },
  cat(name, i) {
    const c = this.cols[name];
    if (!c) return null;
    const k = c.v[i];
    return k === null || k === undefined ? null : c.levels[k];
  },
  num(name, i) { const c = this.cols[name]; return c ? c.v[i] : null; },
  bool(name, i) { const c = this.cols[name]; return c ? !!c.v[i] : false; },
  levels(name) { const c = this.cols[name]; return c && c.levels ? c.levels : []; },
  has(name) { return !!this.cols[name]; }
};

async function loadData() {
  const bust = `?v=${Date.now()}`;
  const [customers, meta] = await Promise.all([
    fetch(`data/customers.json${bust}`).then(r => {
      if (!r.ok) throw new Error(`customers.json -> HTTP ${r.status}`);
      return r.json();
    }),
    fetch(`data/meta.json${bust}`).then(r => r.ok ? r.json() : {})
  ]);
  DS.n = customers.n;
  DS.cols = customers.columns;
  DS.meta = meta;
  if (Array.isArray(meta.sub_channels) && meta.sub_channels.length) {
    SOURCES = meta.sub_channels;
    SOURCES.forEach(s => { if (!SOURCE_COLOR[s]) SOURCE_COLOR[s] = FALLBACK_COLOR; });
  }
  if (Array.isArray(meta.timing_buckets) && meta.timing_buckets.length) {
    TIMING_BUCKETS = meta.timing_buckets;
  }
  return DS;
}

/* ---------------------------------------------------------------------- */
/* filtering                                                               */
/* ---------------------------------------------------------------------- */
function applyFilters(f) {
  const cohort = DS.cols.cohort_month;
  const out = [];
  // Resolve set filters to integer code sets once, not per row.
  const codeSet = (col, chosen) => {
    if (!chosen || chosen.size === 0 || !DS.cols[col]) return null;
    const s = new Set();
    DS.cols[col].levels.forEach((lvl, i) => { if (chosen.has(lvl)) s.add(i); });
    return s;
  };
  const stateS = codeSet('state', f.state);
  const cityS = codeSet('city', f.city);
  const branchS = codeSet('branch', f.branch);
  const mat = DS.cols.maturity_months.v;

  for (let i = 0; i < DS.n; i++) {
    const cm = cohort.levels[cohort.v[i]];
    if (cm < f.cohortFrom || cm > f.cohortTo) continue;
    if (f.maturityMin && mat[i] < f.maturityMin) continue;
    if (stateS && !stateS.has(DS.cols.state.v[i])) continue;
    if (cityS && !cityS.has(DS.cols.city.v[i])) continue;
    if (branchS && !branchS.has(DS.cols.branch.v[i])) continue;
    out.push(i);
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* helpers                                                                 */
/* ---------------------------------------------------------------------- */
function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (a, b) => (b ? +(100 * a / b).toFixed(2) : 0);

/** Group row indices by a categorical column. */
function groupBy(idx, col) {
  const map = new Map();
  const c = DS.cols[col];
  for (const i of idx) {
    const key = c.levels[c.v[i]] ?? '(none)';
    let bucket = map.get(key);
    if (!bucket) map.set(key, bucket = []);
    bucket.push(i);
  }
  return map;
}

/* ---------------------------------------------------------------------- */
/* aggregations                                                            */
/* ---------------------------------------------------------------------- */
const AGG = {

  summary(idx) {
    let referrers = 0, referrals = 0, converted = 0, installs = 0, pre = 0, value = 0, successful = 0;
    const days = [];
    const suc = DS.cols.is_successful_referrer ? DS.cols.is_successful_referrer.v : null;
    const isRef = DS.cols.is_referrer.v, rt = DS.cols.referrals_total.v,
          rc = DS.cols.referrals_converted.v, ic = DS.cols.install_count.v,
          pi = DS.cols.pre_install_referrer.v, dtf = DS.cols.days_to_first_referral.v,
          ov = DS.cols.order_value ? DS.cols.order_value.v : null;
    for (const i of idx) {
      installs += ic[i] || 0;
      referrals += rt[i] || 0;
      converted += rc[i] || 0;
      if (ov) value += ov[i] || 0;
      if (suc && suc[i]) successful++;
      if (isRef[i]) {
        referrers++;
        if (pi[i]) pre++;
        if (dtf[i] !== null) days.push(dtf[i]);
      }
    }
    return {
      customers: idx.length, installs, referrers, referrals, converted, pre, value, successful,
      rate: pct(referrers, idx.length),
      successRate: pct(successful, idx.length),
      convRate: pct(converted, referrals),
      perReferrer: referrers ? +(referrals / referrers).toFixed(2) : 0,
      medianDays: median(days)
    };
  },

  /** Where each referrer's FIRST referral landed, relative to their install.
   *
   * Commissioning truncates the post-install windows: once commissioned the
   * customer is a live user, not someone mid-installation. Assigned in the ETL
   * so the rule lives in one place.
   */
  timingBuckets(idx) {
    const col = DS.cols.first_timing_bucket;
    if (!col) return [];
    const counts = new Map(TIMING_BUCKETS.map(b => [b, 0]));
    let total = 0;
    for (const i of idx) {
      const v = col.v[i];
      if (v === null || v === undefined) continue;
      const name = col.levels[v];
      if (!counts.has(name)) counts.set(name, 0);
      counts.set(name, counts.get(name) + 1);
      total++;
    }
    return TIMING_BUCKETS.map(b => ({
      bucket: b, customers: counts.get(b) || 0, pct: pct(counts.get(b) || 0, total)
    }));
  },

  /** p50 / p90 days from HOTO to first referral, for pre-installation referrers.
   *
   * Measured from HOTO rather than from installation because that is when the
   * customer relationship starts -- the question is how quickly after handover
   * the referral is captured.
   */
  preInstallTAT(idx) {
    const tatCol = DS.cols.first_tat_from_hoto, sc = DS.cols.activated_by;
    if (!tatCol) return { overall: null, bySubChannel: [] };
    const all = [], byCh = new Map();
    for (const i of idx) {
      const v = tatCol.v[i];
      if (v === null || v === undefined) continue;
      all.push(v);
      const name = sc && sc.v[i] !== null && sc.v[i] !== undefined ? sc.levels[sc.v[i]] : 'Others';
      if (!byCh.has(name)) byCh.set(name, []);
      byCh.get(name).push(v);
    }
    const q = (arr, p) => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    };
    return {
      overall: all.length ? { n: all.length, p50: q(all, 0.5), p90: q(all, 0.9) } : null,
      bySubChannel: SOURCES
        .filter(s => byCh.has(s))
        .map(s => ({ sub_channel: s, n: byCh.get(s).length,
                     p50: q(byCh.get(s), 0.5), p90: q(byCh.get(s), 0.9) }))
    };
  },

  /** Sub-Channel of a customer's first referral BEFORE vs AFTER installation.
   *
   * A customer who referred on both sides of their installation is counted in
   * both columns, so these do not sum to the referrer count.
   */
  subChannelBeforeAfter(idx) {
    const pre = DS.cols.sub_channel_pre, post = DS.cols.sub_channel_post;
    const tally = (col) => {
      const m = new Map();
      if (!col) return m;
      for (const i of idx) {
        const v = col.v[i];
        if (v === null || v === undefined) continue;
        const name = col.levels[v];
        m.set(name, (m.get(name) || 0) + 1);
      }
      return m;
    };
    const b = tally(pre), a = tally(post);
    return SOURCES
      .map(s => ({ sub_channel: s, before: b.get(s) || 0, after: a.get(s) || 0 }))
      .filter(r => r.before || r.after);
  },

  /** The Installed -> Recommended -> IDV -> Referrer funnel.
   *
   * Survey non-response is reported as its own stage. Without it the drop from
   * 100% to ~7% reads as "customers will not recommend us", when it actually
   * says "we have not asked most of them" -- 91% of those who DO answer are
   * promoters.
   */
  funnelStages(idx) {
    const n = idx.length;
    const cols = {
      answered: DS.cols.nps_answered, rec: DS.cols.cx_recommended,
      idv: DS.cols.idv_done, ref: DS.cols.is_referrer,
      suc: DS.cols.is_successful_referrer
    };
    const count = c => {
      if (!c) return null;
      let k = 0;
      for (const i of idx) if (c.v[i]) k++;
      return k;
    };
    const rows = [
      { stage: 'Installed', customers: n },
      { stage: 'Answered the survey', customers: count(cols.answered), coverage: true },
      { stage: 'Cx Recommended', customers: count(cols.rec) },
      { stage: 'IDV done', customers: count(cols.idv) },
      { stage: 'Referrer', customers: count(cols.ref) },
      { stage: 'Successful referrer', customers: count(cols.suc) }
    ].filter(r => r.customers !== null);
    return rows.map(r => ({ ...r, pct: pct(r.customers, n) }));
  },

  /** Does saying you would recommend actually predict referring?
   *
   * Split on the survey answer rather than on the funnel, so "did not answer"
   * is visible as its own group instead of being lumped with detractors.
   */
  byNpsGroup(idx) {
    const ans = DS.cols.nps_answered, score = DS.cols.nps_score;
    const ref = DS.cols.is_referrer.v;
    const suc = DS.cols.is_successful_referrer ? DS.cols.is_successful_referrer.v : null;
    const rt = DS.cols.referrals_total.v;
    if (!ans || !score) return [];
    const min = (DS.meta.funnel_config || {}).min_score || 9;
    const groups = new Map();
    const put = (k, i) => {
      let a = groups.get(k);
      if (!a) groups.set(k, a = { group: k, base: 0, referrers: 0, successful: 0, referrals: 0 });
      a.base++;
      a.referrals += rt[i] || 0;
      if (ref[i]) a.referrers++;
      if (suc && suc[i]) a.successful++;
    };
    for (const i of idx) {
      if (!ans.v[i]) { put('Did not answer', i); continue; }
      const v = score.v[i];
      if (v === null || v === undefined) { put('Did not answer', i); continue; }
      if (v >= min) put(`Recommended (${min}-10)`, i);
      else if (v >= 7) put('Passive (7-8)', i);
      else put('Detractor (0-6)', i);
    }
    const order = [`Recommended (${min}-10)`, 'Passive (7-8)', 'Detractor (0-6)', 'Did not answer'];
    return order.filter(k => groups.has(k)).map(k => {
      const a = groups.get(k);
      return { ...a,
               rate: pct(a.referrers, a.base),
               successRate: pct(a.successful, a.base),
               perCustomer: +(a.referrals / a.base).toFixed(2) };
    });
  },

  /** Second level of detail, for the two Sub-Channels that need it.
   *
   * Online splits into campaign-driven and unprompted, which convert very
   * differently. Others splits into the routes that have no employee role for
   * structural reasons (partners, employees) versus genuinely missing data.
   */
  subChannelDetail(idx) {
    const col = DS.cols.sub_channel_detail;
    if (!col) return [];
    const isRef = DS.cols.is_referrer.v;
    const rt = DS.cols.referrals_total.v;
    const suc = DS.cols.is_successful_referrer ? DS.cols.is_successful_referrer.v : null;
    const m = new Map();
    let total = 0;
    for (const i of idx) {
      if (!isRef[i]) continue;
      const v = col.v[i];
      if (v === null || v === undefined) continue;
      const k = col.levels[v];
      let a = m.get(k);
      if (!a) m.set(k, a = { detail: k, referrers: 0, successful: 0, referrals: 0 });
      a.referrers++;
      a.referrals += rt[i] || 0;
      if (suc && suc[i]) a.successful++;
      total++;
    }
    return [...m.values()]
      .map(a => ({ ...a,
                   share: pct(a.referrers, total),
                   successShare: pct(a.successful, a.referrers) }))
      .sort((x, y) => y.referrers - x.referrers);
  },

  /** cohort x months-since-install, cumulative activation %, maturity-masked */
  triangle(idx, maxM = 24) {
    const g = groupBy(idx, 'cohort_month');
    const mtf = DS.cols.months_to_first_referral.v;
    const mat = DS.cols.maturity_months.v;
    const isRef = DS.cols.is_referrer.v;
    const rows = [];
    for (const cohort of [...g.keys()].sort()) {
      const rowsIdx = g.get(cohort);
      const size = rowsIdx.length;
      let maturity = 0, referrers = 0;
      for (const i of rowsIdx) { if (mat[i] > maturity) maturity = mat[i]; if (isRef[i]) referrers++; }
      const cells = [];
      for (let m = 0; m <= maxM; m++) {
        if (m > maturity) { cells.push(null); continue; }
        let hit = 0;
        for (const i of rowsIdx) if (mtf[i] !== null && mtf[i] <= m) hit++;
        cells.push(pct(hit, size));
      }
      rows.push({ cohort, size, maturity, referrers, cells });
    }
    return { months: Array.from({ length: maxM + 1 }, (_, i) => i), rows };
  },

  /** Activation % measured at a fixed age, so cohorts are comparable. */
  indexedRate(idx, atMonth) {
    const t = this.triangle(idx, Math.max(atMonth, 1));
    return t.rows.map(r => ({
      cohort: r.cohort,
      size: r.size,
      value: r.maturity >= atMonth ? r.cells[atMonth] : null,
      partial: r.maturity < atMonth
    }));
  },

  volumeByCohort(idx) {
    const g = groupBy(idx, 'cohort_month');
    const isRef = DS.cols.is_referrer.v;
    return [...g.keys()].sort().map(cohort => {
      const rows = g.get(cohort);
      let referrers = 0;
      for (const i of rows) if (isRef[i]) referrers++;
      return { cohort, base: rows.length, referrers, rate: pct(referrers, rows.length) };
    });
  },

  /** Counts of first-referral activation source, by cohort. */
  sourceMixByCohort(idx) {
    const g = groupBy(idx, 'cohort_month');
    const ab = DS.cols.activated_by;
    const cohorts = [...g.keys()].sort();
    const series = {};
    SOURCES.forEach(s => series[s] = []);
    for (const cohort of cohorts) {
      const counts = Object.fromEntries(SOURCES.map(s => [s, 0]));
      for (const i of g.get(cohort)) {
        const v = ab.v[i];
        if (v === null || v === undefined) continue;
        const name = ab.levels[v];
        if (counts[name] !== undefined) counts[name]++;
      }
      SOURCES.forEach(s => series[s].push(counts[s]));
    }
    return { cohorts, series };
  },

  sourceStats(idx) {
    const ab = DS.cols.activated_by, rt = DS.cols.referrals_total.v,
          rc = DS.cols.referrals_converted.v, isRef = DS.cols.is_referrer.v,
          dtf = DS.cols.days_to_first_referral.v;
    const suc = DS.cols.is_successful_referrer ? DS.cols.is_successful_referrer.v : null;
    const acc = Object.fromEntries(SOURCES.map(s =>
      [s, { source: s, referrers: 0, referrals: 0, converted: 0, repeat: 0, successful: 0, days: [] }]));
    let totalReferrers = 0;
    for (const i of idx) {
      if (!isRef[i]) continue;
      const v = ab.v[i];
      if (v === null || v === undefined) continue;
      const a = acc[ab.levels[v]];
      if (!a) continue;
      totalReferrers++;
      a.referrers++;
      if (suc && suc[i]) a.successful++;
      a.referrals += rt[i] || 0;
      a.converted += rc[i] || 0;
      if ((rt[i] || 0) >= 2) a.repeat++;
      if (dtf[i] !== null) a.days.push(dtf[i]);
    }
    return SOURCES.map(s => {
      const a = acc[s];
      return {
        source: s,
        referrers: a.referrers,
        successful: a.successful,
        successShare: pct(a.successful, a.referrers),
        share: pct(a.referrers, totalReferrers),
        referrals: a.referrals,
        avgReferrals: a.referrers ? +(a.referrals / a.referrers).toFixed(2) : 0,
        repeatRate: pct(a.repeat, a.referrers),
        convRate: pct(a.converted, a.referrals),
        medianDays: median(a.days)
      };
    }).filter(r => r.referrers > 0);
  },

  /** base / referrers / rate for any categorical dimension */
  byDimension(idx, col, minBase = 1) {
    if (!DS.has(col)) return [];
    const g = groupBy(idx, col);
    const isRef = DS.cols.is_referrer.v, rt = DS.cols.referrals_total.v;
    const out = [];
    for (const [key, rows] of g) {
      let referrers = 0, referrals = 0;
      for (const i of rows) { if (isRef[i]) referrers++; referrals += rt[i] || 0; }
      if (rows.length < minBase) continue;
      out.push({
        key, base: rows.length, referrers, referrals,
        rate: pct(referrers, rows.length),
        perCustomer: +(referrals / rows.length).toFixed(3)
      });
    }
    return out.sort((a, b) => b.base - a.base);
  },

  /** Distribution of first-referral timing, relative to commissioning.
   *
   * Most referrals land within a couple of months either side of
   * commissioning, so the months near zero are kept as individual bars and
   * only the thin tails are grouped. Lumping all pre-install referrals into
   * one bucket would hide the shape, which is the whole point of the chart.
   */
  timingHistogram(idx) {
    const mtf = DS.cols.months_to_first_referral.v;
    const BINS = [
      { key: -99, label: '7m+ before', test: m => m <= -7, pre: true },
      ...[-6, -5, -4, -3, -2, -1].map(m => ({ key: m, label: `${-m}m before`, test: x => x === m, pre: true })),
      { key: 0, label: 'same month', test: m => m === 0, pre: false },
      ...[1, 2, 3, 4, 5, 6].map(m => ({ key: m, label: `${m}m after`, test: x => x === m, pre: false })),
      { key: 90, label: '7-12m after', test: m => m >= 7 && m <= 12, pre: false },
      { key: 91, label: '13-24m after', test: m => m >= 13 && m <= 24, pre: false },
      { key: 92, label: '24m+ after', test: m => m > 24, pre: false }
    ];
    const counts = BINS.map(() => 0);
    let total = 0;
    for (const i of idx) {
      const m = mtf[i];
      if (m === null || m === undefined) continue;
      total++;
      for (let b = 0; b < BINS.length; b++) {
        if (BINS[b].test(m)) { counts[b]++; break; }
      }
    }
    return BINS.map((b, n) => ({
      key: b.key, label: b.label, count: counts[n], pre: b.pre,
      pct: pct(counts[n], total)
    })).filter(b => b.count > 0);
  },

  /** Pre- vs post-commissioning split, measured in DAYS.
   *
   * Not the same as counting negative month buckets: a referral 13 days before
   * commissioning in the same calendar month is "before" by days but lands in
   * the "same month" bar. Days is the honest number for the headline.
   */
  preInstallSplit(idx) {
    const isRef = DS.cols.is_referrer.v, dtf = DS.cols.days_to_first_referral.v;
    let pre = 0, post = 0;
    for (const i of idx) {
      if (!isRef[i] || dtf[i] === null) continue;
      if (dtf[i] < 0) pre++; else post++;
    }
    return { pre, post, total: pre + post, prePct: pct(pre, pre + post) };
  },

  prePost(idx) {
    const isRef = DS.cols.is_referrer.v, pi = DS.cols.pre_install_referrer.v,
          rt = DS.cols.referrals_total.v, rc = DS.cols.referrals_converted.v;
    const g = { pre: { n: 0, referrals: 0, converted: 0, repeat: 0 },
                post: { n: 0, referrals: 0, converted: 0, repeat: 0 } };
    for (const i of idx) {
      if (!isRef[i]) continue;
      const k = pi[i] ? 'pre' : 'post';
      g[k].n++;
      g[k].referrals += rt[i] || 0;
      g[k].converted += rc[i] || 0;
      if ((rt[i] || 0) >= 2) g[k].repeat++;
    }
    return ['pre', 'post'].map(k => ({
      group: k === 'pre' ? 'Referred before install' : 'Referred after install',
      n: g[k].n,
      avgReferrals: g[k].n ? +(g[k].referrals / g[k].n).toFixed(2) : 0,
      repeatRate: pct(g[k].repeat, g[k].n),
      convRate: pct(g[k].converted, g[k].referrals)
    }));
  },

  speedByCohort(idx, minMaturity = 6) {
    const g = groupBy(idx, 'cohort_month');
    const isRef = DS.cols.is_referrer.v, dtf = DS.cols.days_to_first_referral.v,
          mat = DS.cols.maturity_months.v;
    const out = [];
    for (const cohort of [...g.keys()].sort()) {
      const rows = g.get(cohort);
      if (!rows.length || mat[rows[0]] < minMaturity) continue;
      const days = [];
      for (const i of rows) if (isRef[i] && dtf[i] !== null && dtf[i] >= 0) days.push(dtf[i]);
      if (days.length < 5) continue;  // too few to carry a stable median
      out.push({ cohort, median: median(days), n: days.length });
    }
    return out;
  },

  depth(idx, maxN = 8) {
    const isRef = DS.cols.is_referrer.v, rt = DS.cols.referrals_total.v;
    const referrers = [];
    for (const i of idx) if (isRef[i]) referrers.push(rt[i] || 0);
    const total = referrers.length;
    return Array.from({ length: maxN }, (_, k) => {
      const n = k + 1;
      const count = referrers.reduce((acc, v) => acc + (v >= n ? 1 : 0), 0);
      return { n, count, pct: pct(count, total) };
    });
  },

  /** Average referrals given, by how long the customer has been on the base. */
  velocityByMaturity(idx) {
    const mat = DS.cols.maturity_months.v, rt = DS.cols.referrals_total.v,
          isRef = DS.cols.is_referrer.v;
    const bands = [[0, 2], [3, 5], [6, 8], [9, 11], [12, 17], [18, 23], [24, 999]];
    return bands.map(([lo, hi]) => {
      let n = 0, refCount = 0, referrals = 0;
      for (const i of idx) {
        if (mat[i] < lo || mat[i] > hi) continue;
        n++;
        referrals += rt[i] || 0;
        if (isRef[i]) refCount++;
      }
      return {
        label: hi === 999 ? '24m+' : `${lo}-${hi}m`,
        base: n,
        perCustomer: n ? +(referrals / n).toFixed(2) : 0,
        perReferrer: refCount ? +(referrals / refCount).toFixed(2) : 0,
        rate: pct(refCount, n)
      };
    }).filter(b => b.base > 0);
  },

  durabilityBySource(idx) {
    const ab = DS.cols.activated_by, rt = DS.cols.referrals_total.v,
          isRef = DS.cols.is_referrer.v;
    const acc = Object.fromEntries(SOURCES.map(s => [s, { one: 0, two: 0, three: 0 }]));
    for (const i of idx) {
      if (!isRef[i]) continue;
      const v = ab.v[i];
      if (v === null || v === undefined) continue;
      const a = acc[ab.levels[v]];
      if (!a) continue;
      const n = rt[i] || 0;
      if (n >= 3) a.three++; else if (n === 2) a.two++; else a.one++;
    }
    return SOURCES
      .map(s => ({ source: s, ...acc[s], total: acc[s].one + acc[s].two + acc[s].three }))
      .filter(r => r.total > 0);
  },

  /** Non-referrers by cohort, split by whether they have had a fair chance yet. */
  gapByCohort(idx, fairMonths = 6) {
    const g = groupBy(idx, 'cohort_month');
    const isRef = DS.cols.is_referrer.v, mat = DS.cols.maturity_months.v;
    return [...g.keys()].sort().map(cohort => {
      let mature = 0, young = 0, referrers = 0;
      for (const i of g.get(cohort)) {
        if (isRef[i]) { referrers++; continue; }
        if (mat[i] >= fairMonths) mature++; else young++;
      }
      return { cohort, referrers, mature, young, base: g.get(cohort).length };
    });
  },

  /** Largest pools of mature non-referrers, by a chosen segmentation. */
  gapSegments(idx, cols, fairMonths = 6, limit = 60) {
    const isRef = DS.cols.is_referrer.v, mat = DS.cols.maturity_months.v;
    const avail = cols.filter(c => DS.has(c));
    const map = new Map();
    for (const i of idx) {
      if (mat[i] < fairMonths) continue;
      const key = avail.map(c => DS.cat(c, i) ?? '(none)').join(' · ');
      let a = map.get(key);
      if (!a) map.set(key, a = { key, base: 0, referrers: 0, untapped: 0 });
      a.base++;
      if (isRef[i]) a.referrers++; else a.untapped++;
    }
    return [...map.values()]
      .map(a => ({ ...a, rate: pct(a.referrers, a.base) }))
      .sort((x, y) => y.untapped - x.untapped)
      .slice(0, limit);
  },

  /** Untapped pool weighted by how well comparable customers activate. */
  prioritySegments(idx, cols, fairMonths = 6, limit = 40) {
    const rows = this.gapSegments(idx, cols, fairMonths, 500);
    const overall = this.summary(idx).rate;
    return rows
      .filter(r => r.base >= 20)
      .map(r => ({
        ...r,
        // Expected additional referrers if this segment reached its own peers' rate.
        headroom: Math.round(r.untapped * (r.rate / 100)),
        vsAvg: +(r.rate - overall).toFixed(2)
      }))
      .sort((a, b) => b.headroom - a.headroom)
      .slice(0, limit);
  }
};
