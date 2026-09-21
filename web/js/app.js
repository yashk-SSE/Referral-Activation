/* Filter state, tab routing, and panel rendering. */
'use strict';

const F = {
  from: null, to: null,          // ISO dates on the installation date
  state: new Set(), branch: new Set()
};
let activeTab = 'sales';
let drilldownOn = true;

/* ---------------------------------------------------------------------- */
/* Searchable multi-select. A chip row cannot carry 131 cities, and a native
 * <select multiple> is unusable for picking a handful out of that many. */
function buildMultiSelect(elId, col, set, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!DS.has(col)) { el.closest('.filter').hidden = true; return; }

  // Option counts make it obvious which values actually carry volume.
  const c = DS.cols[col];
  const counts = new Map();
  for (let i = 0; i < DS.n; i++) {
    const v = c.v[i];
    if (v === null || v === undefined) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const options = c.levels
    .map((name, code) => ({ name, n: counts.get(code) || 0 }))
    .filter(o => o.n > 0)
    .sort((a, b) => b.n - a.n);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ms-btn';

  const panel = document.createElement('div');
  panel.className = 'ms-panel';
  panel.hidden = true;

  const search = document.createElement('input');
  search.className = 'ms-search';
  search.type = 'search';
  search.placeholder = 'Search ' + label.toLowerCase();

  const list = document.createElement('div');
  list.className = 'ms-list';

  const foot = document.createElement('div');
  foot.className = 'ms-foot';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Clear';
  const count = document.createElement('span');
  foot.append(clear, count);

  panel.append(search, list, foot);
  el.append(btn, panel);

  const syncButton = () => {
    if (set.size === 0) btn.textContent = 'All ' + label.toLowerCase();
    else if (set.size === 1) btn.textContent = [...set][0];
    else btn.textContent = set.size + ' selected';
    btn.classList.toggle('active', set.size > 0);
    count.textContent = set.size + ' of ' + options.length;
  };

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = q ? options.filter(o => o.name.toLowerCase().includes(q)) : options;
    list.innerHTML = '';
    if (!shown.length) { list.innerHTML = '<div class="ms-empty">No match.</div>'; return; }
    for (const o of shown) {
      const row = document.createElement('label');
      row.className = 'ms-opt';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = set.has(o.name);
      box.addEventListener('change', () => {
        if (box.checked) set.add(o.name); else set.delete(o.name);
        syncButton();
        render();
      });
      const text = document.createElement('span');
      text.textContent = o.name;
      const n = document.createElement('span');
      n.className = 'ms-n';
      n.textContent = o.n.toLocaleString();
      row.append(box, text, n);
      list.appendChild(row);
    }
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = panel.hidden;
    document.querySelectorAll('.ms-panel').forEach(x => { x.hidden = true; });
    panel.hidden = !opening;
    if (opening) { paint(); search.focus(); }
  });
  panel.addEventListener('click', e => e.stopPropagation());
  search.addEventListener('input', paint);
  clear.addEventListener('click', () => { set.clear(); paint(); syncButton(); render(); });

  el._reset = () => { set.clear(); search.value = ''; syncButton(); };
  syncButton();
}

// One listener closes whichever panel is open.
document.addEventListener('click', () => {
  document.querySelectorAll('.ms-panel').forEach(x => { x.hidden = true; });
});

/* ---------------------------------------------------------------------- */
/* Installation-date range. Day level, not month: "Last 7 days" cannot be
 * expressed on a month grain. */
function isoDay(d) { return d.toISOString().slice(0, 10); }

function presetRange(key, maxDay) {
  const end = new Date(maxDay + 'T00:00:00Z');
  const y = end.getUTCFullYear(), m = end.getUTCMonth();
  const startOfMonth = k => isoDay(new Date(Date.UTC(y, m - k, 1)));
  const endOfMonth = k => isoDay(new Date(Date.UTC(y, m - k + 1, 0)));
  switch (key) {
    case '7d': {
      const s = new Date(end); s.setUTCDate(s.getUTCDate() - 6);
      return [isoDay(s), maxDay];
    }
    case 'tm': return [startOfMonth(0), maxDay];
    case 'pm': return [startOfMonth(1), endOfMonth(1)];
    // "Last N months" means the last N COMPLETE months -- the current month is
    // still accumulating installations and would drag every rate down.
    case '3m': return [startOfMonth(3), endOfMonth(1)];
    case '6m': return [startOfMonth(6), endOfMonth(1)];
    default: return [null, null];
  }
}

function buildFilters() {
  const dates = DS.cols.first_install_date;
  const days = dates ? dates.levels.slice().sort() : [];
  const minDay = days[0] || null;
  const maxDay = DS.meta.as_of || days[days.length - 1] || null;

  const fromEl = document.getElementById('fFrom');
  const toEl = document.getElementById('fTo');
  if (minDay) { fromEl.min = minDay; toEl.min = minDay; }
  if (maxDay) { fromEl.max = maxDay; toEl.max = maxDay; }

  const setRange = (a, b, presetKey) => {
    F.from = a; F.to = b;
    fromEl.value = a || '';
    toEl.value = b || '';
    document.querySelectorAll('#datePresets button').forEach(btn =>
      btn.classList.toggle('on', btn.dataset.preset === presetKey));
    render();
  };

  document.querySelectorAll('#datePresets button').forEach(btn => {
    btn.addEventListener('click', () => {
      const [a, b] = btn.dataset.preset === 'all'
        ? [minDay, maxDay]
        : presetRange(btn.dataset.preset, maxDay);
      setRange(a, b, btn.dataset.preset);
    });
  });
  // Typing a date clears the preset highlight -- it is now a custom range.
  [fromEl, toEl].forEach(el => el.addEventListener('change', () => {
    F.from = fromEl.value || null;
    F.to = toEl.value || null;
    document.querySelectorAll('#datePresets button').forEach(b => b.classList.remove('on'));
    render();
  }));

  buildMultiSelect('fState', 'state', F.state, 'States');
  buildMultiSelect('fBranch', 'branch', F.branch, 'Clusters');

  // On a phone the full filter block is taller than the screen, so it starts
  // collapsed behind a summary showing what is actually applied.
  const fToggle = document.getElementById('filterToggle');
  const fSection = document.querySelector('.filters');
  fToggle.addEventListener('click', () => {
    const open = fSection.classList.toggle('open');
    fSection.classList.toggle('collapsed', !open);
    fToggle.setAttribute('aria-expanded', String(open));
  });

  const toggle = document.getElementById('drillToggle');
  toggle.addEventListener('click', () => {
    drilldownOn = !drilldownOn;
    toggle.setAttribute('aria-checked', String(drilldownOn));
    toggle.querySelector('.t-label').textContent = drilldownOn ? 'On' : 'Off';
    render();
  });

  // Changing the cluster invalidates whichever consultant was chosen -- they
  // may not work that cluster at all -- so clear it rather than silently
  // showing an empty book.
  document.getElementById('ddCluster').addEventListener('change', e => {
    DD.cluster = e.target.value;
    DD.sc = '';
    render();
  });
  document.getElementById('ddSc').addEventListener('change', e => {
    DD.sc = e.target.value;
    render();
  });
  // Delegated, because renderTable replaces the table on every sort.
  document.getElementById('tblSc').addEventListener('click', e => {
    const hit = e.target.closest('.sc-pick');
    if (!hit) return;
    DD.sc = DD.sc === hit.dataset.sc ? '' : hit.dataset.sc;
    render();
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    F.state.clear(); F.branch.clear();
    DD.cluster = ''; DD.sc = '';
    document.querySelectorAll('.ms').forEach(el => { if (el._reset) el._reset(); });
    const [a, b] = presetRange('3m', maxDay);
    setRange(a, b, '3m');
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      document.querySelectorAll('.panel').forEach(p => {
        p.hidden = p.dataset.panel !== activeTab;
      });
      render();
    });
  });

  // Default view: the last three complete months.
  const [a, b] = presetRange('3m', maxDay);
  setRange(a, b, '3m');
}

/* ---------------------------------------------------------------------- */
function kpi(label, value, note, cls) {
  return '<div class="kpi ' + (cls || '') + '"><div class="k-label">' + label + '</div>' +
         '<div class="k-value">' + value + '</div>' +
         '<div class="k-note">' + (note || '&nbsp;') + '</div></div>';
}

function renderKPIs(s, a) {
  document.getElementById('kpis').innerHTML = [
    kpi('Installed base', fmtInt(s.customers), 'customers in range'),
    kpi('Referrer activation', fmtInt(a.activated), fmtPct(a.rate) + ' of the base', 'k-good'),
    kpi('Orders activation', fmtInt(a.successful), fmtPct(a.successRate) + ' of the base', 'k-good'),
    kpi('Not referred', fmtInt(s.customers - a.activated),
        fmtPct(100 - a.rate) + ' of the base', 'k-warn'),
    kpi('# Leads', fmtInt(a.leads), a.leadsPer + ' per activated referrer'),
    kpi('# Orders', fmtInt(a.orders), a.ordersPer + ' per activated referrer'),
    kpi('Lifetime referrers', fmtInt(s.referrers),
        fmtPct(s.rate) + ' ignoring the window', 'k-flat')
  ].join('');
}

const dot = v =>
  '<span style="color:' + (SOURCE_COLOR[v] || '#94a3b8') + ';font-weight:700">&#9679;</span> ' + v;

/* ---------------------------------------------------------------------- */
/* City Deep Dive selection.
 *
 * Deliberately separate from F: the filter bar decides which customers are in
 * play at all, this decides which slice of them the deep dive is looking at.
 * Empty string means "no narrowing", which keeps it comparable with a <select>
 * value directly. */
const DD = { cluster: '', sc: '' };

/** Repopulate a <select>, keeping the current choice when it still exists.
 *
 * Options are derived from the rows currently in play, so a change to the date
 * range or the State filter can remove whatever was selected. Falling back to
 * "all" is the honest outcome -- the alternative is a picker showing a cluster
 * that contributes no rows. */
function fillSelect(el, options, value, allLabel) {
  const keep = options.some(o => o.name === value) ? value : '';
  el.innerHTML = '<option value="">' + escHtml(allLabel) + '</option>' +
    options.map(o =>
      '<option value="' + escAttr(o.name) + '">' +
      escHtml(o.name) + ' &middot; ' + fmtInt(o.n) + '</option>').join('');
  el.value = keep;
  return keep;
}

/** The rows of the month-on-month matrix, in reading order.
 *
 * Built fresh each render because the Sub-Channel and window lists come from
 * meta.json, which is only known after the data loads. */
function matrixRows() {
  const ratio = v => v.toFixed(2);
  const rows = [
    { section: 'Base' },
    { label: 'Installed base', get: t => t.installed, metric: 'installed', strong: true },
    { label: 'Cx Recommended', get: t => t.cx_recommended, metric: 'cx_recommended' },
    { label: 'IDV visits', get: t => t.idv, metric: 'idv' },
    { section: 'Activation' },
    { label: 'Referrer activation', get: t => t.referrer_activated,
      metric: 'referrer_activated', strong: true },
    { label: 'Act %', get: t => t.activation_rate, fmt: fmtPct, rate: true },
    { label: 'Orders activation', get: t => t.successful_activated,
      metric: 'successful_activated' },
    { label: 'Order %', get: t => t.success_rate, fmt: fmtPct, rate: true },
    { label: 'Not referred', get: t => t.not_referred, metric: 'not_referred' },
    { section: 'Referral output' },
    { label: '# Leads', get: t => t.leads, metric: 'leads' },
    { label: '# Orders', get: t => t.orders, metric: 'orders' },
    { label: 'Leads / referrer', get: t => t.leads_per_referrer, fmt: ratio, rate: true },
    { label: 'Orders / referrer', get: t => t.orders_per_referrer, fmt: ratio, rate: true },
    { section: 'Who activated them' }
  ];
  // These two blocks split referrer_activated two ways, so each sums back to it.
  SOURCES.forEach(s => rows.push({
    label: dot(s), sub: true, get: t => t.bySubChannel[s] || 0, metric: 'sub:' + s
  }));
  rows.push({ section: 'When they activated' });
  inWindowBuckets().forEach(w => rows.push({
    label: w, sub: true, get: t => t.byWindow[w] || 0, metric: 'win:' + w
  }));
  return rows;
}

/* ---------------------------------------------------------------------- */
const PANELS = {

  sales(idx, s) {
    const cfg = DS.meta.activation || { start: -3, end: 90 };
    document.getElementById('salesWindowNote').innerHTML =
      'A customer counts as <strong>activated</strong> if they gave a referral between ' +
      '<strong>' + cfg.start + '</strong> and <strong>+' + cfg.end + ' days</strong> of ' +
      'their installation &mdash; the span covering installation, commissioning, subsidy ' +
      'disbursal and the first zero bill.';

    // Cluster is the ops accountability unit and matches the Cluster filter.
    const rows = AGG.cityTable(idx, 'branch');
    const pctCol = (k, l) => ({ key: k, label: l, num: true, pct: true });
    const numCol = (k, l, metric) => ({ key: k, label: l, num: true, metric: metric || k });
    renderTable('tblCity', [
      { key: 'name', label: 'Cluster' },
      numCol('installed', 'Installed base'),
      numCol('cx_recommended', 'Cx Recommended'),
      numCol('idv', 'IDV visits'),
      numCol('referrer_activated', 'Referrer activation', 'referrer_activated'),
      pctCol('activation_rate', 'Act %'),
      numCol('successful_activated', 'Orders activation', 'successful_activated'),
      pctCol('success_rate', 'Order %'),
      numCol('not_referred', 'Not referred', 'not_referred'),
      numCol('leads', '# Leads'),
      numCol('orders', '# Orders'),
      { key: 'leads_per_referrer', label: 'Leads / referrer', num: true, fmt: v => v.toFixed(2) },
      { key: 'orders_per_referrer', label: 'Orders / referrer', num: true, fmt: v => v.toFixed(2) }
    ], rows, { sortKey: 'installed', drilldown: drilldownOn, totalRow: 'India (all)' });

    const missing = missingIdentityColumns();
    const india = rows[0];
    document.getElementById('salesFinding').innerHTML = india
      ? '<strong>' + fmtInt(india.referrer_activated) + '</strong> of ' +
        fmtInt(india.installed) + ' installed customers activated in-window (' +
        fmtPct(india.activation_rate) + '), producing ' + fmtInt(india.leads) +
        ' leads and ' + fmtInt(india.orders) + ' orders. <strong>' +
        fmtInt(india.not_referred) + '</strong> have not referred.' +
        (missing.length
          ? ' <em>Downloads exclude customer identity &mdash; this build is in ' +
            'public mode. Rebuild with <code>--mode gated</code> for the full sheet.</em>'
          : '')
      : '';

    // The public build has no customer identity by design; the named sheet
    // lives in Google, restricted to the Workspace domain.
    const link = document.getElementById('sheetLink');
    if (DS.meta.sheet_url && missing.length) {
      link.hidden = false;
      link.innerHTML =
        '<a href="' + DS.meta.sheet_url + '" target="_blank" rel="noopener">' +
        'Open the full customer sheet &rarr;</a>' +
        '<span> SSEID, name and Installation Champion live there, ' +
        'restricted to the SolarSquare Google Workspace.</span>';
    } else {
      link.hidden = true;
    }

    const mix = AGG.subChannelByWindow(idx);
    chartWindowMix(mix);
    renderTable('tblWindowTat', [
      { key: 'sub_channel', label: 'Sub-Channel', fmt: dot },
      { key: 'n', label: 'Activated', num: true, bar: true },
      { key: 'p50', label: 'p50 days', num: true },
      { key: 'p90', label: 'p90 days', num: true },
      { key: 'mean', label: 'Mean days', num: true, fmt: v => v.toFixed(1) }
    ], mix.tat, { sortKey: 'n' });
  },

  /* One cluster, every metric, month by month -- and who on the ground owns it. */
  deepdive(idx) {
    const clusters = AGG.countsBy(idx, 'branch');
    DD.cluster = fillSelect(document.getElementById('ddCluster'), clusters,
                            DD.cluster, 'India — all clusters');
    const scopeIdx = DD.cluster ? AGG.pickCat(idx, 'branch', DD.cluster) : idx;

    // sc_name ships in the public build specifically so this works; if a build
    // ever drops it, hide the control rather than showing an empty picker.
    const hasSc = DS.has('sc_name');
    document.getElementById('ddScField').hidden = !hasSc;
    document.getElementById('cardSc').hidden = !hasSc;
    const consultants = hasSc ? AGG.countsBy(scopeIdx, 'sc_name', '(not assigned)') : [];
    DD.sc = hasSc
      ? fillSelect(document.getElementById('ddSc'), consultants, DD.sc, 'All consultants')
      : '';
    const viewIdx = DD.sc ? AGG.pickCat(scopeIdx, 'sc_name', DD.sc, '(not assigned)') : scopeIdx;

    const where = DD.cluster || 'India';
    const label = where + (DD.sc ? ' · ' + DD.sc : '');
    document.getElementById('ddTitle').textContent = label;
    document.getElementById('ddScTitle').textContent =
      DD.cluster || 'India (all clusters)';
    document.getElementById('ddScope').innerHTML =
      '<strong>' + fmtInt(viewIdx.length) + '</strong> customers in scope, ' +
      'out of ' + fmtInt(idx.length) + ' matching the filters above' +
      (DD.sc ? ' &mdash; ' + escHtml(DD.sc) + '&rsquo;s book inside ' + escHtml(where)
             : (DD.cluster ? ' &mdash; all consultants in ' + escHtml(where) : '')) + '.';

    const mm = AGG.monthlyMatrix(viewIdx);
    const columns = mm.months.map(t => ({ key: t.name, label: t.label, stats: t }));
    columns.push({ key: '__total', label: 'Total', stats: mm.total, total: true });
    renderMatrix('tblMonthly', matrixRows(), columns,
                 { drilldown: drilldownOn, label });

    // Compare the first and last full month in view. With one month there is no
    // trend to report, so say the level instead of inventing a direction.
    const f = mm.months[0], l = mm.months[mm.months.length - 1];
    const fin = document.getElementById('ddFinding');
    if (!f) { fin.innerHTML = ''; }
    else if (mm.months.length === 1) {
      fin.innerHTML = '<strong>' + escHtml(label) + '</strong> installed ' +
        fmtInt(f.installed) + ' customers in ' + f.label + ', of whom ' +
        fmtInt(f.referrer_activated) + ' activated (' + fmtPct(f.activation_rate) + ').';
    } else {
      const delta = +(l.activation_rate - f.activation_rate).toFixed(1);
      fin.innerHTML = '<strong>' + escHtml(label) + '</strong> activation moved from ' +
        fmtPct(f.activation_rate) + ' in ' + f.label + ' to ' +
        fmtPct(l.activation_rate) + ' in ' + l.label +
        ' (<span class="' + (delta >= 0 ? 'pos' : 'neg') + '">' +
        (delta >= 0 ? '+' : '') + delta + ' pt</span>), on ' +
        fmtInt(mm.total.installed) + ' customers installed across ' +
        mm.months.length + ' months. ' + l.label + ' is still inside its own ' +
        ((DS.meta.activation || {}).end || 90) + '-day window, so it will keep rising.';
    }

    if (!hasSc) return;
    // The table always lists every consultant in the cluster, selected or not --
    // the point is to rank them against each other, not to look at one alone.
    const numCol = (k, l, metric) => ({ key: k, label: l, num: true, metric: metric || k });
    renderTable('tblSc', [
      { key: 'name', label: 'Solar Consultant',
        fmt: v => '<span class="sc-pick" data-sc="' + escAttr(v) + '">' + escHtml(v) + '</span>' },
      numCol('installed', 'Installed base'),
      numCol('referrer_activated', 'Referrer activation'),
      { key: 'activation_rate', label: 'Act %', num: true, pct: true },
      numCol('successful_activated', 'Orders activation'),
      { key: 'success_rate', label: 'Order %', num: true, pct: true },
      numCol('not_referred', 'Not referred'),
      numCol('leads', '# Leads'),
      numCol('orders', '# Orders'),
      { key: 'leads_per_referrer', label: 'Leads / referrer', num: true, fmt: v => v.toFixed(2) },
      { key: 'orders_per_referrer', label: 'Orders / referrer', num: true, fmt: v => v.toFixed(2) }
    ], AGG.scTable(scopeIdx),
       { sortKey: 'installed', drilldown: drilldownOn, highlight: DD.sc });
  }
};

/* With no rows in view, charts and tables would otherwise keep displaying the
 * previous filter's results, which reads as real data rather than as nothing. */
function setEmptyState(panel, empty) {
  panel.classList.toggle('is-empty', empty);
  let box = panel.querySelector('.empty-state');
  if (!empty) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.className = 'empty-state';
    box.innerHTML = 'No customers match these filters.<br>' +
      '<span>Widen the month range or clear a filter &mdash; some combinations, ' +
      'like a state paired with another state&rsquo;s city, cannot overlap.</span>';
    panel.appendChild(box);
  }
}

function render() {
  const idx = applyFilters(F);
  const s = AGG.summary(idx);
  renderKPIs(s, AGG.activationSummary(idx));
  const panel = document.querySelector('.panel[data-panel="' + activeTab + '"]');
  setEmptyState(panel, idx.length === 0);
  if (idx.length) PANELS[activeTab](idx, s);
  const bits = [];
  if (F.from) bits.push(F.from + ' to ' + F.to);
  if (F.state.size) bits.push(F.state.size === 1 ? [...F.state][0] : F.state.size + ' states');
  if (F.branch.size) bits.push(F.branch.size === 1 ? [...F.branch][0] : F.branch.size + ' clusters');
  document.getElementById('filterSummary').textContent = bits.join(' · ');

  document.getElementById('footMeta').textContent =
    fmtInt(idx.length) + ' of ' + fmtInt(DS.n) + ' installed customers in view' +
    (F.from ? ' · installed ' + F.from + ' to ' + F.to : '');
  requestAnimationFrame(resizeAll);
}

/* ---------------------------------------------------------------------- */
loadData().then(() => {
  const badge = document.getElementById('modeBadge');
  const sample = DS.meta.source === 'sample';
  badge.textContent = sample ? 'Sample data' : (DS.meta.mode === 'gated' ? 'Row-level' : 'Aggregate');
  badge.classList.toggle('sample', sample);
  // Show when the data was actually pulled, with the time -- a date alone does
  // not tell anyone whether this morning's refresh has landed.
  const gen = DS.meta.generated_at || '';
  // Always render in IST and say so. The build runs on a UTC runner, so
  // without an explicit zone the stamp reads 5.5 hours stale to this team.
  const stamp = gen
    ? new Date(gen).toLocaleString('en-IN',
        { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
          year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST'
    : '—';
  document.getElementById('refreshedAt').textContent = stamp;

  document.getElementById('footWarn').textContent =
    DS.meta.source === 'sample' ? 'Synthetic data — not real numbers.' : '';

  buildFilters();
  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
  render();
}).catch(err => {
  document.getElementById('loading').hidden = true;
  const box = document.getElementById('loadError');
  box.hidden = false;
  console.error(err);

  // Distinguish "the data never arrived" from "the data arrived and rendering
  // broke" -- they have completely different fixes.
  if (DS.n > 0) {
    box.textContent =
      'The data loaded (' + DS.n.toLocaleString() + ' customers) but the dashboard ' +
      'failed to render.\n\n' + err.message + '\n\n' +
      (typeof echarts === 'undefined'
        ? 'The charting library did not load. Check that web/vendor/echarts.min.js exists.'
        : 'See the browser console for the full stack trace.');
    return;
  }
  box.textContent =
    'Could not load the dashboard data.\n\n' + err.message + '\n\n' +
    'If you are opening index.html directly from disk, fetch() is blocked by the browser.\n' +
    'Serve it over HTTP instead:\n\n    python -m http.server 8000 --directory web\n\n' +
    'then open http://localhost:8000\n\n' +
    'If data/customers.json is missing, build it first:\n\n    python etl/build.py';
});
