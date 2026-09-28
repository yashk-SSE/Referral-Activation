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
  buildReferralIndex(customers);
  const a = meta.activation || {};
  WIN.start = a.start !== undefined ? a.start : -3;
  WIN.end = a.end !== undefined ? a.end : 90;
  WIN.defStart = WIN.start; WIN.defEnd = WIN.end;
  SUB_WINDOWS = Array.isArray(meta.sub_windows) ? meta.sub_windows : [];
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
/* the activation window, and everything derived from it                   */
/* ---------------------------------------------------------------------- */
/* Every referral's day-offset from its own customer's installation, laid out
 * CSR-style: customer i owns day[start[i] .. start[i+1]). This is what makes
 * the window configurable here rather than baked into the build -- the ETL
 * ships offsets, the dashboard decides what counts. */
const REF = { start: null, day: null, conv: null, sub: null, subLevels: [] };
let SUB_WINDOWS = [];

function buildReferralIndex(payload) {
  const r = payload.referrals;
  if (!r || !r.count) return;
  const n = r.count.length;
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + r.count[i];
  REF.start = start;
  REF.day = Int16Array.from(r.day);
  REF.conv = Uint8Array.from(r.conv);
  REF.sub = Uint8Array.from(r.sub);
  REF.subLevels = r.sub_levels || [];
}

/* capAtCommissioning reproduces what the ETL has always done, and it is not a
 * small detail: assign_timing_bucket caps the LAST sub-window at commissioning,
 * and because the sub-windows tile the range, a referral after commissioning
 * falls out of the window entirely -- even though it sits inside +90. So the
 * headline "-3 to +90" has always meant "-3 to whichever of +90 and
 * commissioning comes first". Switching the cap off raises activation by about
 * 70%, so it defaults ON and changing it is a deliberate act. */
const WIN = { start: -3, end: 90, defStart: -3, defEnd: 90,
              capAtCommissioning: true, _cache: null };
function setWindow(start, end, cap) {
  WIN.start = start; WIN.end = end;
  if (cap !== undefined) WIN.capAtCommissioning = !!cap;
  WIN._cache = null;
}
const windowIsDefault = () =>
  WIN.start === WIN.defStart && WIN.end === WIN.defEnd && WIN.capAtCommissioning;

/** Does this referral count, for the window as currently configured? */
function inWindow(day, comm) {
  if (day < WIN.start || day > WIN.end) return false;
  if (!WIN.capAtCommissioning) return true;
  // Faithful to the ETL: in-window means it lands in some sub-window, and the
  // last sub-window stops at commissioning.
  return SUB_WINDOWS.length ? subWindowOf(day, comm) !== null : true;
}

/* One pass over 56k referrals, then cached. statsFor runs hundreds of times a
 * render and must not re-walk them each time. */
function winStats() {
  if (WIN._cache) return WIN._cache;
  const n = DS.n;
  const c = {
    activated: new Uint8Array(n), successful: new Uint8Array(n),
    leads: new Int32Array(n), orders: new Int32Array(n),
    firstDay: new Int16Array(n), hasFirst: new Uint8Array(n),
    sub: new Uint8Array(n)
  };
  if (!REF.start) return (WIN._cache = c);
  const comm = DS.cols.commissioning_offset;
  for (let i = 0; i < n; i++) {
    const a = REF.start[i], b = REF.start[i + 1];
    const co = comm ? comm.v[i] : null;
    let l = 0, o = 0, seen = 0;
    for (let k = a; k < b; k++) {
      const d = REF.day[k];
      if (!inWindow(d, co)) continue;
      l++;
      if (REF.conv[k]) o++;
      // Referrals are stored in time order within a customer, so the first one
      // to pass the filter is their first IN-WINDOW referral.
      if (!seen) { seen = 1; c.firstDay[i] = d; c.sub[i] = REF.sub[k]; }
    }
    c.leads[i] = l; c.orders[i] = o;
    c.activated[i] = l > 0 ? 1 : 0;
    c.successful[i] = o > 0 ? 1 : 0;
    c.hasFirst[i] = seen;
  }
  return (WIN._cache = c);
}

const subChannelOf = i => {
  const c = winStats();
  return c.hasFirst[i] ? (REF.subLevels[c.sub[i]] || 'Others') : null;
};

/** Which reporting sub-window a day offset falls in, for the active window.
 *
 * The last sub-window is capped by commissioning: once commissioned the
 * customer is a live user, not someone mid-installation. */
function subWindowOf(day, commissioningOffset) {
  for (const w of SUB_WINDOWS) {
    const lo = w.start;
    const hi = (w.cap_at_commissioning && WIN.capAtCommissioning)
      ? Math.min(commissioningOffset === null || commissioningOffset === undefined
                 ? WIN.end : commissioningOffset, WIN.end)
      : (w.end === null || w.end === undefined ? WIN.end : w.end);
    if (day >= lo && day <= hi) return w.label;
  }
  return null;
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
  return (LIVE = { rec: any(DS.cols.cx_recommended),
                   idv: any(DS.cols.idv_done),
                   idvSched: any(DS.cols.idv_scheduled) });
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
  const w = winStats();
  const rec = DS.cols.cx_recommended, idv = DS.cols.idv_done;
  const idvs = DS.cols.idv_scheduled;
  const comm = DS.cols.commissioning_offset;

  const t = {
    name, rows,
    installed: rows.length,
    // A placeholder must render as a dash, never as a zero -- "nobody
    // recommended us" and "we are not measuring it yet" are different claims.
    cx_recommended: live.rec ? 0 : null,
    idv: live.idv ? 0 : null,
    idv_scheduled: live.idvSched ? 0 : null,
    referrer_activated: 0, successful_activated: 0, leads: 0, orders: 0,
    bySubChannel: {}, byWindow: {}
  };
  for (const i of rows) {
    if (w.activated[i]) {
      t.referrer_activated++;
      // Sub-Channel and window are read only for activated customers, so these
      // tallies always sum back to referrer_activated.
      const sc = REF.subLevels[w.sub[i]];
      if (sc) t.bySubChannel[sc] = (t.bySubChannel[sc] || 0) + 1;
      const bk = subWindowOf(w.firstDay[i], comm ? comm.v[i] : null);
      if (bk) t.byWindow[bk] = (t.byWindow[bk] || 0) + 1;
    }
    if (w.successful[i]) t.successful_activated++;
    t.leads += w.leads[i];
    t.orders += w.orders[i];
    if (live.rec && rec.v[i]) t.cx_recommended++;
    if (live.idv && idv.v[i]) t.idv++;
    if (live.idvSched && idvs.v[i]) t.idv_scheduled++;
  }
  t.not_referred = t.installed - t.referrer_activated;
  t.activation_rate = pct(t.referrer_activated, t.installed);
  t.success_rate = pct(t.successful_activated, t.installed);
  // Leads per 100 installed customers. Unlike activation_rate this is not a
  // share of anything -- one customer can give five referrals -- so it can and
  // does exceed 100%.
  t.leads_rate = pct(t.leads, t.installed);
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
    const w = winStats();
    let activated = 0, successful = 0, leads = 0, orders = 0;
    for (const i of idx) {
      if (w.activated[i]) activated++;
      if (w.successful[i]) successful++;
      leads += w.leads[i];
      orders += w.orders[i];
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

  /** The timing buckets, clipped to whatever window is active.
   *
   * The six are the shape the business reads activation in. If the window is
   * narrower they are trimmed; if it is wider, the overflow gets its own
   * bucket rather than being silently dropped.
   */
  speedBuckets() {
    const RAW = [[-3, 0], [1, 3], [4, 10], [11, 30], [31, 60], [61, 90]];
    const out = [];
    if (WIN.start < -3) out.push({ lo: WIN.start, hi: -4 });
    for (const [lo, hi] of RAW) {
      const a = Math.max(lo, WIN.start), b = Math.min(hi, WIN.end);
      if (a > b) continue;
      out.push({ lo: a, hi: b });
    }
    if (WIN.end > 90) out.push({ lo: 91, hi: WIN.end });
    return out.map(b => ({ ...b, label: b.lo + ' to ' + b.hi }));
  },

  /** Activated customers split across those buckets, one row per cluster. */
  speedTable(idx, dim) {
    const buckets = this.speedBuckets();
    const w = winStats();
    const build = (name, rows) => {
      const r = { name, rows, installed: rows.length, activated: 0,
                  counts: buckets.map(() => 0), bucketRows: buckets.map(() => []) };
      for (const i of rows) {
        if (!w.activated[i]) continue;
        r.activated++;
        const d = w.firstDay[i];
        for (let b = 0; b < buckets.length; b++) {
          if (d >= buckets[b].lo && d <= buckets[b].hi) {
            r.counts[b]++; r.bucketRows[b].push(i); break;
          }
        }
      }
      return r;
    };
    const out = [build('India (all)', idx)];
    for (const [key, rows] of [...groupRows(idx, dim || 'branch').entries()]
        .sort((a, b) => b[1].length - a[1].length)) out.push(build(key, rows));
    return { buckets, rows: out };
  },

  /** Cumulative activation by day since installation, per group.
   *
   * The point of this cut: it compares a young cohort with a mature one at the
   * SAME age. "August looks worse than June" is unanswerable on a rate alone,
   * because August has not lived through its window yet -- but "at day 30,
   * August was at 12.1% against June's 11.4%" is a fair comparison.
   */
  speedCurve(idx, dim) {
    const w = winStats();
    const days = [];
    for (let d = WIN.start; d <= WIN.end; d++) days.push(d);
    const span = days.length;
    const series = [];
    for (const [key, rows] of [...groupRows(idx, dim || 'cohort_month').entries()]
        .sort((a, b) => (dim === 'branch' ? b[1].length - a[1].length
                                          : String(a[0]).localeCompare(String(b[0]))))) {
      const hist = new Int32Array(span);
      for (const i of rows) if (w.activated[i]) hist[w.firstDay[i] - WIN.start]++;
      let run = 0;
      const values = [];
      for (let k = 0; k < span; k++) { run += hist[k]; values.push(pct(run, rows.length)); }
      series.push({ name: key, base: rows.length, values });
    }
    return { days, series };
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

  /** Row indices matching one value, or any of several, in a column. */
  pickCat(idx, col, value, fallback) {
    const c = DS.cols[col];
    if (!c) return idx;
    const wanted = Array.isArray(value) ? value : [value];
    if (!wanted.length) return idx;
    const codes = new Set();
    // The fallback label stands for NULL, which has no level of its own.
    let wantNull = false;
    for (const v of wanted) {
      const code = c.levels.indexOf(v);
      if (code >= 0) codes.add(code);
      else if (v === fallback) wantNull = true;
    }
    if (!codes.size && !wantNull) return [];
    return idx.filter(i => {
      const v = c.v[i];
      return (v === null || v === undefined) ? wantNull : codes.has(v);
    });
  },

  /** Clusters down the side, metric groups across, each split by month.
   *
   * The transpose of monthlyMatrix: that one answers "how is this cluster
   * moving", this one answers "which clusters are moving". Both come through
   * statsFor, so they cannot disagree.
   */
  momByCluster(idx, dim) {
    const mcol = DS.cols.cohort_month;
    const keys = new Set();
    if (mcol) {
      for (const i of idx) {
        const v = mcol.v[i];
        if (v !== null && v !== undefined) keys.add(mcol.levels[v]);
      }
    }
    const monthKeys = [...keys].sort();
    const months = monthKeys.map(k => ({ key: k, label: monthLabel(k) }));

    const build = (name, rows) => {
      const byMonth = groupRows(rows, 'cohort_month', '(none)');
      return {
        name,
        cells: monthKeys.map(k => statsFor(byMonth.get(k) || [], name)),
        total: statsFor(rows, name)
      };
    };
    // India first and pinned; the rest by size, as on the cluster table.
    const out = [build('India (all)', idx)];
    for (const [key, rows] of [...groupRows(idx, dim || 'branch').entries()]
        .sort((a, b) => b[1].length - a[1].length)) {
      out.push(build(key, rows));
    }
    return { months, rows: out };
  },

  /** One row per Solar Consultant, same metric set as the cluster table.
   *
   * Attribution is lead.assigned_sc on the customer's own order -- the book the
   * consultant handed over, not whoever chased the referral later.
   */
  scTable(idx) {
    if (!DS.has('sc_name')) return [];
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
    const c = winStats(), comm = DS.cols.commissioning_offset;
    const windows = inWindowBuckets();
    const series = {};
    SOURCES.forEach(s => { series[s] = windows.map(() => 0); });
    const tatBy = new Map();
    for (const i of idx) {
      if (!c.activated[i]) continue;
      const bk = subWindowOf(c.firstDay[i], comm ? comm.v[i] : null);
      const sc = REF.subLevels[c.sub[i]];
      const wi = windows.indexOf(bk);
      if (sc && series[sc] && wi >= 0) series[sc][wi]++;
      if (sc) {
        if (!tatBy.has(sc)) tatBy.set(sc, []);
        tatBy.get(sc).push(c.firstDay[i]);
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
  return SUB_WINDOWS.length
    ? SUB_WINDOWS.map(w => w.label)
    : (TIMING_BUCKETS || []).filter(
        b => b.indexOf('blindspot') === -1 && b !== 'After window');
}
