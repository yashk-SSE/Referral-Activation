/* Filter state, tab routing, and panel rendering. */
'use strict';

const F = {
  cohortFrom: null, cohortTo: null,
  state: new Set(), city: new Set(), branch: new Set(),
  maturityMin: 0
};
let activeTab = 'overview';

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
function buildFilters() {
  const cohorts = DS.levels('cohort_month').slice().sort();
  const from = document.getElementById('fCohortFrom');
  const to = document.getElementById('fCohortTo');
  cohorts.forEach(c => { from.add(new Option(c, c)); to.add(new Option(c, c)); });
  F.cohortFrom = cohorts[0];
  F.cohortTo = cohorts[cohorts.length - 1];
  from.value = F.cohortFrom;
  to.value = F.cohortTo;
  from.addEventListener('change', () => { F.cohortFrom = from.value; render(); });
  to.addEventListener('change', () => { F.cohortTo = to.value; render(); });

  buildMultiSelect('fState', 'state', F.state, 'States');
  buildMultiSelect('fCity', 'city', F.city, 'Cities');
  buildMultiSelect('fBranch', 'branch', F.branch, 'Clusters');

  document.getElementById('fMaturity').addEventListener('change', e => {
    F.maturityMin = +e.target.value;
    render();
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    F.cohortFrom = cohorts[0];
    F.cohortTo = cohorts[cohorts.length - 1];
    F.maturityMin = 0;
    from.value = F.cohortFrom;
    to.value = F.cohortTo;
    document.getElementById('fMaturity').value = '0';
    document.querySelectorAll('.ms').forEach(el => { if (el._reset) el._reset(); });
    render();
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
}

/* ---------------------------------------------------------------------- */
function kpi(label, value, note) {
  return '<div class="kpi"><div class="k-label">' + label + '</div>' +
         '<div class="k-value">' + value + '</div>' +
         '<div class="k-note">' + (note || '&nbsp;') + '</div></div>';
}

function renderKPIs(s, split) {
  document.getElementById('kpis').innerHTML = [
    kpi('Installed', fmtInt(s.customers), 'customers in range'),
    kpi('Referrers', fmtInt(s.referrers), fmtPct(s.rate) + ' of the base'),
    kpi('Successful referrers', fmtInt(s.successful), fmtPct(s.successRate) + ' of the base'),
    kpi('Never referred', fmtInt(s.customers - s.referrers), fmtPct(100 - s.rate) + ' of the base'),
    kpi('Referrals given', fmtInt(s.referrals), s.perReferrer + ' per referrer'),
    kpi('Became orders', fmtInt(s.converted), fmtPct(s.convRate) + ' of referrals'),
    kpi('Referred before install', fmtPct(split.prePct),
        fmtInt(split.pre) + ' of ' + fmtInt(split.total) + ' referrers')
  ].join('');
}

const dot = v =>
  '<span style="color:' + (SOURCE_COLOR[v] || '#94a3b8') + ';font-weight:700">&#9679;</span> ' + v;

/* ---------------------------------------------------------------------- */
const PANELS = {
  overview(idx, s) {
    const buckets = AGG.timingBuckets(idx);
    chartTimingBuckets(buckets);

    const tat = AGG.preInstallTAT(idx).overall;
    const before = buckets.find(b => b.bucket === 'Before installation');
    const week = buckets
      .filter(b => b.bucket.indexOf('Install + 0-3') === 0 || b.bucket.indexOf('Install + 4-7') === 0)
      .reduce((n, b) => n + b.pct, 0);
    document.getElementById('timingFinding').innerHTML = buckets.length
      ? '<strong>' + fmtPct(before ? before.pct : 0) + '</strong> of referrers give their ' +
        'first referral <strong>before installation</strong>' +
        (tat ? ', a median of <strong>' + fmtInt(tat.p50) + ' days</strong> after HOTO (p90 ' +
               fmtInt(tat.p90) + ' days)' : '') +
        '. A further ' + fmtPct(week) + ' come in within a week of installation.'
      : '';

    chartCohort(AGG.volumeByCohort(idx));
    chartDepth(AGG.depth(idx, 6));
  },

  activation(idx, s) {
    const stats = AGG.sourceStats(idx);
    chartSource(stats);
    chartBeforeAfter(AGG.subChannelBeforeAfter(idx));

    renderTable('tblSource', [
      { key: 'source', label: 'Sub-Channel', fmt: dot },
      { key: 'referrers', label: 'Referrers', num: true, bar: true },
      { key: 'share', label: 'Share', num: true, pct: true },
      { key: 'successful', label: 'Successful', num: true },
      { key: 'successShare', label: 'Success rate', num: true, pct: true },
      { key: 'referrals', label: 'Referrals', num: true },
      { key: 'avgReferrals', label: 'Each gave', num: true, fmt: v => v.toFixed(2) },
      { key: 'repeatRate', label: 'Refers again', num: true, pct: true },
      { key: 'convRate', label: 'Became orders', num: true, pct: true }
    ], stats, { sortKey: 'referrers' });

    const others = AGG.othersBreakdown(idx);
    chartOthers(others);
    renderTable('tblOthers', [
      { key: 'detail', label: 'Inside Others' },
      { key: 'referrers', label: 'Referrers', num: true, bar: true },
      { key: 'share', label: 'Share of Others', num: true, pct: true },
      { key: 'successful', label: 'Successful', num: true },
      { key: 'successShare', label: 'Success rate', num: true, pct: true },
      { key: 'referrals', label: 'Referrals', num: true }
    ], others, { sortKey: 'referrers' });

    const tat = AGG.preInstallTAT(idx);
    const rows = tat.bySubChannel.slice();
    if (tat.overall) rows.push({ sub_channel: 'All', ...tat.overall });
    const signed = v => (v < 0 ? fmtInt(-v) + 'd before' : fmtInt(v) + 'd after');
    renderTable('tblTat', [
      { key: 'sub_channel', label: 'Sub-Channel',
        fmt: v => (v === 'All' ? '<strong>' + v + '</strong>' : dot(v)) },
      { key: 'n', label: 'Referrers', num: true, bar: true },
      { key: 'p50', label: 'p50 from HOTO', num: true, fmt: signed },
      { key: 'p90', label: 'p90 from HOTO', num: true, fmt: signed }
    ], rows, { sortKey: 'n' });
  },

  coverage(idx, s) {
    chartGap(AGG.gapByCohort(idx));
    const cols = [
      { key: 'key', label: 'Name' },
      { key: 'untapped', label: 'Never referred', num: true, bar: true },
      { key: 'base', label: 'Customers', num: true },
      { key: 'rate', label: 'Activation', num: true, pct: true },
      { key: 'vsAvg', label: 'vs avg', num: true, signed: true,
        fmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + ' pt' }
    ];
    const decorate = rows => rows.map(r => ({
      ...r, untapped: r.base - r.referrers, vsAvg: +(r.rate - s.rate).toFixed(2)
    }));
    renderTable('tblState', cols, decorate(AGG.byDimension(idx, 'state', 20)), { sortKey: 'untapped' });
    renderTable('tblBranch', cols, decorate(AGG.byDimension(idx, 'city', 20)), { sortKey: 'untapped' });
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
  renderKPIs(s, AGG.preInstallSplit(idx));
  const panel = document.querySelector('.panel[data-panel="' + activeTab + '"]');
  setEmptyState(panel, idx.length === 0);
  if (idx.length) PANELS[activeTab](idx, s);
  document.getElementById('footMeta').textContent =
    fmtInt(idx.length) + ' of ' + fmtInt(DS.n) + ' customers in view · refreshed ' +
    (DS.meta.generated_at || '').replace('T', ' ');
  requestAnimationFrame(resizeAll);
}

/* ---------------------------------------------------------------------- */
loadData().then(() => {
  const badge = document.getElementById('modeBadge');
  const sample = DS.meta.source === 'sample';
  badge.textContent = sample ? 'Sample data' : (DS.meta.mode === 'gated' ? 'Row-level' : 'Aggregate');
  badge.classList.toggle('sample', sample);
  document.getElementById('asOf').textContent =
    (DS.meta.lookback_months || '?') + ' months to ' + (DS.meta.as_of || '—');

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
