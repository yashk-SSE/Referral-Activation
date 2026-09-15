/* Filter state, tab routing, and panel rendering. */
'use strict';

const F = {
  cohortFrom: null, cohortTo: null,
  state: new Set(), branch: new Set(), capacity: new Set(),
  maturityMin: 0
};
let activeTab = 'overview';

/* ---------------------------------------------------------------------- */
function buildChips(elId, col, set) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!DS.has(col)) { el.closest('.filter').hidden = true; return; }
  el.innerHTML = '';
  DS.levels(col).forEach(level => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = level;
    chip.tabIndex = 0;
    const toggle = () => {
      set.has(level) ? set.delete(level) : set.add(level);
      chip.classList.toggle('on', set.has(level));
      render();
    };
    chip.addEventListener('click', toggle);
    chip.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    el.appendChild(chip);
  });
}

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

  buildChips('fState', 'state', F.state);
  buildChips('fBranch', 'branch', F.branch);
  buildChips('fCapacity', 'capacity_band', F.capacity);

  document.getElementById('fMaturity').addEventListener('change', e => {
    F.maturityMin = +e.target.value;
    render();
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    [F.state, F.branch, F.capacity].forEach(s => s.clear());
    F.cohortFrom = cohorts[0];
    F.cohortTo = cohorts[cohorts.length - 1];
    F.maturityMin = 0;
    from.value = F.cohortFrom;
    to.value = F.cohortTo;
    document.getElementById('fMaturity').value = '0';
    document.querySelectorAll('.chip.on').forEach(c => c.classList.remove('on'));
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
  return `<div class="kpi"><div class="k-label">${label}</div>
          <div class="k-value">${value}</div>
          <div class="k-note">${note || '&nbsp;'}</div></div>`;
}

function renderKPIs(s, split) {
  document.getElementById('kpis').innerHTML = [
    kpi('Installed', fmtInt(s.customers), 'customers in range'),
    kpi('Referrers', fmtInt(s.referrers), `${fmtPct(s.rate)} of the base`),
    kpi('Successful referrers', fmtInt(s.successful), `${fmtPct(s.successRate)} of the base`),
    kpi('Never referred', fmtInt(s.customers - s.referrers), `${fmtPct(100 - s.rate)} of the base`),
    kpi('Referrals given', fmtInt(s.referrals), `${s.perReferrer} per referrer`),
    kpi('Became orders', fmtInt(s.converted), `${fmtPct(s.convRate)} of referrals`),
    kpi('Referred before install', fmtPct(split.prePct), `${fmtInt(split.pre)} of ${fmtInt(split.total)} referrers`)
  ].join('');
}

/* ---------------------------------------------------------------------- */
const PANELS = {
  overview(idx, s) {
    const buckets = AGG.timingBuckets(idx);
    chartTimingBuckets(buckets);

    const tat = AGG.preInstallTAT(idx).overall;
    const before = buckets.find(b => b.bucket === 'Before installation');
    const window0to7 = buckets
      .filter(b => b.bucket.startsWith('Install + 0-3') || b.bucket.startsWith('Install + 4-7'))
      .reduce((n, b) => n + b.pct, 0);
    document.getElementById('timingFinding').innerHTML = buckets.length
      ? `<strong>${fmtPct(before ? before.pct : 0)}</strong> of referrers give their first
         referral <strong>before installation</strong>` +
        (tat ? `, a median of <strong>${fmtInt(tat.p50)} days</strong> after HOTO
         (p90 ${fmtInt(tat.p90)} days)` : '') +
        `. A further ${fmtPct(window0to7)} come in within a week of installation.`
      : '';

    chartCohort(AGG.volumeByCohort(idx));
    chartDepth(AGG.depth(idx, 6));
  },

  activation(idx, s) {
    const stats = AGG.sourceStats(idx);
    chartSource(stats);
    chartBeforeAfter(AGG.subChannelBeforeAfter(idx));

    const dot = v =>
      `<span style="color:${SOURCE_COLOR[v] || '#94a3b8'};font-weight:700">&#9679;</span> ${v}`;
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

    const tat = AGG.preInstallTAT(idx);
    const rows = tat.bySubChannel.slice();
    if (tat.overall) rows.push({ sub_channel: 'All', ...tat.overall });
    renderTable('tblTat', [
      { key: 'sub_channel', label: 'Sub-Channel',
        fmt: (v, r) => (v === 'All' ? `<strong>${v}</strong>` : dot(v)) },
      { key: 'n', label: 'Referrers', num: true, bar: true },
      { key: 'p50', label: 'p50 days from HOTO', num: true,
        fmt: v => (v < 0 ? `${fmtInt(-v)}d before` : `${fmtInt(v)}d after`) },
      { key: 'p90', label: 'p90 days from HOTO', num: true,
        fmt: v => (v < 0 ? `${fmtInt(-v)}d before` : `${fmtInt(v)}d after`) }
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
        fmt: v => `${v > 0 ? '+' : ''}${v.toFixed(1)} pt` }
    ];
    const decorate = rows => rows.map(r => ({
      ...r, untapped: r.base - r.referrers, vsAvg: +(r.rate - s.rate).toFixed(2)
    }));
    renderTable('tblState', cols, decorate(AGG.byDimension(idx, 'state', 20)), { sortKey: 'untapped' });
    renderTable('tblBranch', cols, decorate(AGG.byDimension(idx, 'branch', 20)), { sortKey: 'untapped' });
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
      '<span>Widen the month range or clear a chip &mdash; some combinations, ' +
      'like a state paired with another state&rsquo;s cluster, cannot overlap.</span>';
    panel.appendChild(box);
  }
}

function render() {
  const idx = applyFilters(F);
  const s = AGG.summary(idx);
  renderKPIs(s, AGG.preInstallSplit(idx));
  const panel = document.querySelector(`.panel[data-panel="${activeTab}"]`);
  setEmptyState(panel, idx.length === 0);
  if (idx.length) PANELS[activeTab](idx, s);
  document.getElementById('footMeta').textContent =
    `${fmtInt(idx.length)} of ${fmtInt(DS.n)} customers in view · ` +
    `refreshed ${(DS.meta.generated_at || '').replace('T', ' ')}`;
  requestAnimationFrame(resizeAll);
}

/* ---------------------------------------------------------------------- */
loadData().then(() => {
  const badge = document.getElementById('modeBadge');
  const sample = DS.meta.source === 'sample';
  badge.textContent = sample ? 'Sample data' : (DS.meta.mode === 'gated' ? 'Row-level' : 'Aggregate');
  badge.classList.toggle('sample', sample);
  document.getElementById('asOf').textContent =
    `${DS.meta.lookback_months || '?'} months to ${DS.meta.as_of || '—'}`;

  const warn = [];
  if (sample) warn.push('Synthetic data — not real numbers.');
  if (DS.meta.unmapped_source_count) {
    warn.push(`${DS.meta.unmapped_source_count} unrecognised activation value(s) counted as Others.`);
  }
  document.getElementById('footWarn').textContent = warn.join(' ');

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
      `The data loaded (${DS.n.toLocaleString()} customers) but the dashboard failed to render.\n\n` +
      `${err.message}\n\n` +
      `${typeof echarts === 'undefined'
          ? 'The charting library did not load. Check that web/vendor/echarts.min.js exists and is being served.'
          : 'See the browser console for the full stack trace.'}`;
    return;
  }
  box.textContent =
    `Could not load the dashboard data.\n\n${err.message}\n\n` +
    `If you are opening index.html directly from disk, fetch() is blocked by the browser.\n` +
    `Serve it over HTTP instead:\n\n    python -m http.server 8000 --directory web\n\n` +
    `then open http://localhost:8000\n\n` +
    `If data/customers.json is missing, build it first:\n\n    python etl/build.py`;
});
