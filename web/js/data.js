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
  // Filtered on the installation DATE, not the cohort month: the date presets
  // ("Last 7 days") cannot be expressed on a month grain.
  const dates = DS.cols.first_install_date;
  const out = [];
  // Resolve set filters to integer code sets once, not per row.
  const codeSet = (col, chosen) => {
    if (!chosen || chosen.size === 0 || !DS.cols[col]) return null;
    const s = new Set();
    DS.cols[col].levels.forEach((lvl, i) => { if (chosen.has(lvl)) s.add(i); });
    return s;
  };
  const stateS = codeSet('state', f.state);
  const branchS = codeSet('branch', f.branch);

  for (let i = 0; i < DS.n; i++) {
    if (dates && (f.from || f.to)) {
      const code = dates.v[i];
      if (code === null || code === undefined) continue;
      const d = dates.levels[code];               // ISO yyyy-mm-dd sorts as text
      if (f.from && d < f.from) continue;
      if (f.to && d > f.to) continue;
    }
    if (stateS && !stateS.has(DS.cols.state.v[i])) continue;
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
/** Group row indices by a categorical column, keeping the missing ones. */
function groupRows(idx, col, fallback) {
  const c = DS.cols[col];
  const map = new Map();
  for (const i of idx) {
    const v = c ? c.v[i] : null;
    const key = (v === null || v === undefined) ? (fallback || '(unknown)') : c.levels[v];
    let bucket = map.get(key);
    if (!bucket) map.set(key, bucket = []);
    bucket.push(i);
  }
  return map;
}

/** '2026-06' -> 'Jun 26'. Short enough that 24 of them fit across a table. */
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key || '');
  return m ? MONTH_ABBR[+m[2] - 1] + ' ' + m[1].slice(2) : String(key || '');
}

/* Cx Recommended and IDV are still placeholders. Asking "does this column hold
 * any value at all" scans the whole column, and statsFor runs once per month
 * per consultant -- so memoise it rather than rescanning 47k rows each time. */
let LIVE = null;
function liveFlags() {
  if (LIVE) return LIVE;
  const any = c => !!(c && c.v.some(x => x !== null && x !== undefined));
  return (LIVE = { rec: any(DS.cols.cx_recommended), idv: any(DS.cols.idv_done) });
}

/** Every activation metric, over one set of row indices.
 *
 * The cluster table, the month-on-month matrix and the Solar Consultant table
 * all come through here, so they cannot drift apart -- they are the same
 * arithmetic cut three ways. `rows` is kept on the result so a click can
 * rebuild the exact customer list behind any number.
 */
function statsFor(rows, name) {
  const live = liveFlags();
  const act = DS.cols.referrer_activated, suc = DS.cols.successful_activated;
  const lw = DS.cols.leads_in_window, ow = DS.cols.orders_in_window;
  const rec = DS.cols.cx_recommended, idv = DS.cols.idv_done;
  const scol = DS.cols.activated_by_window, wcol = DS.cols.activation_window;

  const t = {
    name, rows,
    installed: rows.length,
    // A placeholder must render as a dash, never as a zero -- "nobody
    // recommended us" and "we are not measuring it yet" are different claims.
    cx_recommended: live.rec ? 0 : null,
    idv: live.idv ? 0 : null,
    referrer_activated: 0, successful_activated: 0, leads: 0, orders: 0,
    bySubChannel: {}, byWindow: {}
  };
  if (act) {
    for (const i of rows) {
      if (act.v[i]) {
        t.referrer_activated++;
        // Sub-Channel and window are read only for activated customers, so
        // these tallies always sum back to referrer_activated.
        const s = scol && scol.v[i] !== null && scol.v[i] !== undefined
          ? scol.levels[scol.v[i]] : null;
        if (s) t.bySubChannel[s] = (t.bySubChannel[s] || 0) + 1;
        const w = wcol && wcol.v[i] !== null && wcol.v[i] !== undefined
          ? wcol.levels[wcol.v[i]] : null;
        if (w) t.byWindow[w] = (t.byWindow[w] || 0) + 1;
      }
      if (suc && suc.v[i]) t.successful_activated++;
      t.leads += (lw && lw.v[i]) || 0;
      t.orders += (ow && ow.v[i]) || 0;
      if (live.rec && rec.v[i]) t.cx_recommended++;
      if (live.idv && idv.v[i]) t.idv++;
    }
  }
  t.not_referred = t.installed - t.referrer_activated;
  t.activation_rate = pct(t.referrer_activated, t.installed);
  t.success_rate = pct(t.successful_activated, t.installed);
  t.leads_per_referrer = t.referrer_activated
    ? +(t.leads / t.referrer_activated).toFixed(2) : 0;
  t.orders_per_referrer = t.referrer_activated
    ? +(t.orders / t.referrer_activated).toFixed(2) : 0;
  return t;
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

  /** Headline activation numbers, all measured inside the window. */
  activationSummary(idx) {
    const act = DS.cols.referrer_activated, suc = DS.cols.successful_activated;
    const lw = DS.cols.leads_in_window, ow = DS.cols.orders_in_window;
    let activated = 0, successful = 0, leads = 0, orders = 0;
    if (act) {
      for (const i of idx) {
        if (act.v[i]) activated++;
        if (suc && suc.v[i]) successful++;
        leads += (lw && lw.v[i]) || 0;
        orders += (ow && ow.v[i]) || 0;
      }
    }
    return {
      activated, successful, leads, orders,
      rate: pct(activated, idx.length),
      successRate: pct(successful, idx.length),
      leadsPer: activated ? +(leads / activated).toFixed(2) : 0,
      ordersPer: activated ? +(orders / activated).toFixed(2) : 0
    };
  },

  /** The Referrer Activation table: one row per cluster, plus an India total.
   *
   * Activation is measured inside the configured window, not lifetime. Cx
   * Recommended and IDV stay null while they are placeholders.
   */
  cityTable(idx, dim) {
    if (!DS.cols.referrer_activated) return [];
    const groups = groupRows(idx, dim || 'city');
    return [statsFor(idx, 'India (all)')].concat(
      [...groups.entries()]
        .map(([key, rows]) => statsFor(rows, key))
        .sort((a, b) => b.installed - a.installed));
  },

  /** Metrics in rows, installation months in columns, for one selection.
   *
   * Grouped on cohort_month -- the month the system was installed -- so a
   * column is a cohort whose referrals are counted inside each customer's own
   * activation window. It is not a calendar month of referral activity, and
   * the newest columns are still filling.
   */
  monthlyMatrix(idx) {
    const groups = groupRows(idx, 'cohort_month', '(no install month)');
    const months = [...groups.keys()].sort().map(key => {
      const t = statsFor(groups.get(key), key);
      t.label = monthLabel(key);
      return t;
    });
    const total = statsFor(idx, 'Total');
    total.label = 'Total';
    return { months, total };
  },

  /** Distinct values of a column with their row counts, biggest first.
   *
   * Feeds the deep-dive pickers, so it is computed over the rows currently in
   * play rather than over the whole dataset -- a cluster that contributes
   * nothing to the current date range should not be offered. */
  countsBy(idx, col, fallback) {
    if (!DS.has(col)) return [];
    return [...groupRows(idx, col, fallback).entries()]
      .map(([name, rows]) => ({ name, n: rows.length }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  },

  /** Row indices whose value in a categorical column equals `value`. */
  pickCat(idx, col, value, fallback) {
    const c = DS.cols[col];
    if (!c) return idx;
    const code = c.levels.indexOf(value);
    // The fallback label stands for NULL, which has no level of its own.
    if (code < 0) return value === fallback
      ? idx.filter(i => c.v[i] === null || c.v[i] === undefined) : [];
    return idx.filter(i => c.v[i] === code);
  },

  /** One row per Solar Consultant, same metric set as the cluster table.
   *
   * Attribution is lead.assigned_sc on the customer's own order -- the book the
   * consultant handed over, not whoever chased the referral later.
   */
  scTable(idx) {
    if (!DS.has('sc_name') || !DS.cols.referrer_activated) return [];
    const groups = groupRows(idx, 'sc_name', '(not assigned)');
    return [...groups.entries()]
      .map(([key, rows]) => statsFor(rows, key))
      .sort((a, b) => b.installed - a.installed);
  },

  /** Who activates, and in which window after installation.
   *
   * Counted on the customer's first IN-WINDOW referral, so it reconciles with
   * referrer_activated. Blindspot referrals take no part.
   */
  subChannelByWindow(idx) {
    const wcol = DS.cols.activation_window, scol = DS.cols.activated_by_window;
    const act = DS.cols.referrer_activated, dta = DS.cols.days_to_activation;
    if (!wcol || !scol || !act) return { windows: [], series: {}, tat: [] };
    const windows = inWindowBuckets();
    const series = {};
    SOURCES.forEach(s => { series[s] = windows.map(() => 0); });
    const tatBy = new Map();
    for (const i of idx) {
      if (!act.v[i]) continue;
      const w = wcol.v[i] === null || wcol.v[i] === undefined ? null : wcol.levels[wcol.v[i]];
      const sc = scol.v[i] === null || scol.v[i] === undefined ? null : scol.levels[scol.v[i]];
      const wi = windows.indexOf(w);
      if (sc && series[sc] && wi >= 0) series[sc][wi]++;
      if (sc && dta && dta.v[i] !== null && dta.v[i] !== undefined) {
        if (!tatBy.has(sc)) tatBy.set(sc, []);
        tatBy.get(sc).push(dta.v[i]);
      }
    }
    const q = (arr, p) => {
      const a = arr.slice().sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
    };
    const tat = SOURCES.filter(s => tatBy.has(s)).map(s => ({
      sub_channel: s, n: tatBy.get(s).length,
      p50: q(tatBy.get(s), 0.5), p90: q(tatBy.get(s), 0.9),
      mean: +(tatBy.get(s).reduce((a, b) => a + b, 0) / tatBy.get(s).length).toFixed(1)
    }));
    return { windows, series, tat };
  }
};

/** The timing buckets that sit inside the activation window.
 *
 * The blindspot is excluded by design, and "After window" cannot appear among
 * activated customers -- a referral past +90 days does not activate anyone. */
function inWindowBuckets() {
  return (TIMING_BUCKETS || []).filter(
    b => b.indexOf('blindspot') === -1 && b !== 'After window');
}
