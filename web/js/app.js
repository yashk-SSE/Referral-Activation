/* Filter state, tab routing, and panel rendering. */
'use strict';

const F = {
  cohortFrom: null, cohortTo: null,
  state: new Set(), branch: new Set(), channel: new Set(), capacity: new Set(),
  maturityMin: 0
};
let activeTab = 'overview';
let INDEXED_AT = 6;   // months of maturity used for fair cohort comparison

/* ---------------------------------------------------------------------- */
function buildChips(elId, col, set) {
  const el = document.getElementById(elId);
  if (!el || !DS.has(col)) { if (el) el.closest('.filter').hidden = true; return; }
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
    chip.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    el.appendChild(chip);
  });
}

function buildFilters() {
  const cohorts = DS.levels('cohort_month').slice().sort();
  const from = document.getElementById('fCohortFrom');
  const to = document.getElementById('fCohortTo');
  cohorts.forEach(c => {
    from.add(new Option(c, c));
    to.add(new Option(c, c));
  });
  F.cohortFrom = cohorts[0];
  F.cohortTo = cohorts[cohorts.length - 1];
  from.value = F.cohortFrom;
  to.value = F.cohortTo;
  from.addEventListener('change', () => { F.cohortFrom = from.value; render(); });
  to.addEventListener('change', () => { F.cohortTo = to.value; render(); });

  buildChips('fState', 'state', F.state);
  buildChips('fBranch', 'branch', F.branch);
  buildChips('fChannel', 'acquisition_channel', F.channel);
  buildChips('fCapacity', 'capacity_band', F.capacity);

  document.getElementById('fMaturity').addEventListener('change', e => {
    F.maturityMin = +e.target.value;
    render();
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    [F.state, F.branch, F.channel, F.capacity].forEach(s => s.clear());
    F.cohortFrom = cohorts[0]; F.cohortTo = cohorts[cohorts.length - 1]; F.maturityMin = 0;
    from.value = F.cohortFrom; to.value = F.cohortTo;
    document.getElementById('fMaturity').value = '0';
    document.querySelectorAll('.chip.on').forEach(c => c.classList.remove('on'));
    render();
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== activeTab; });
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

function renderKPIs(s) {
  const crore = v => v >= 1e7 ? `₹${(v / 1e7).toFixed(1)} Cr` : `₹${(v / 1e5).toFixed(1)} L`;
  document.getElementById('kpis').innerHTML = [
    kpi('Customer base', fmtInt(s.customers), `${fmtInt(s.installs)} installations`),
    kpi('Became referrers', fmtInt(s.referrers), `${fmtPct(s.rate)} of the base`),
    kpi('Referrals given', fmtInt(s.referrals), `${s.perReferrer} per referrer`),
    kpi('Referrals converted', fmtInt(s.converted), `${fmtPct(s.convRate)} of referrals`),
    kpi('Median time to refer', s.medianDays === null ? '—' : `${fmtInt(s.medianDays)}d`, 'after installation'),
    kpi('Referred pre-install', fmtInt(s.pre), s.referrers ? `${fmtPct(100 * s.pre / s.referrers)} of referrers` : ''),
    kpi('Never referred', fmtInt(s.customers - s.referrers), `${fmtPct(100 - s.rate)} of the base`)
  ].join('');
}

/* ---------------------------------------------------------------------- */
const PANELS = {
  overview(idx, s) {
    renderTriangle('triangle', AGG.triangle(idx));
    chartIndexed(AGG.indexedRate(idx, INDEXED_AT), INDEXED_AT);
    chartVolume(AGG.volumeByCohort(idx));
  },

  activation(idx, s) {
    const mix = AGG.sourceMixByCohort(idx);
    chartSourceMix(mix);
    chartSourceShare(mix);
    renderTable('tblSource', [
      { key: 'source', label: 'Activated by', fmt: v => `<span style="color:${SOURCE_COLOR[v]};font-weight:600">●</span> ${v}` },
      { key: 'referrers', label: 'Referrers', num: true, bar: true },
      { key: 'share', label: 'Share', num: true, pct: true },
      { key: 'avgReferrals', label: 'Avg refs', num: true, fmt: v => v.toFixed(2) },
      { key: 'repeatRate', label: 'Repeat', num: true, pct: true },
      { key: 'convRate', label: 'Lead→install', num: true, pct: true },
      { key: 'medianDays', label: 'Median days', num: true }
    ], AGG.sourceStats(idx), { sortKey: 'referrers' });
  },

  geography(idx, s) {
    chartState(AGG.byDimension(idx, 'state', 20), s.rate);
    const branches = AGG.byDimension(idx, 'branch', 15);
    chartBranchScatter(branches, s.rate);
    renderTable('tblBranch', [
      { key: 'key', label: 'Branch' },
      { key: 'base', label: 'Base', num: true, bar: true },
      { key: 'referrers', label: 'Referrers', num: true },
      { key: 'rate', label: 'Activation', num: true, pct: true },
      { key: 'vsAvg', label: 'vs avg', num: true, signed: true, fmt: v => `${v > 0 ? '+' : ''}${v.toFixed(1)} pt` },
      { key: 'untapped', label: 'Untapped', num: true },
      { key: 'perCustomer', label: 'Refs/customer', num: true, fmt: v => v.toFixed(2) }
    ], branches.map(b => ({ ...b, vsAvg: +(b.rate - s.rate).toFixed(2), untapped: b.base - b.referrers })),
       { sortKey: 'base' });
  },

  timing(idx, s) {
    chartTiming(AGG.timingHistogram(idx));
    chartPrePost(AGG.prePost(idx));
    chartSpeed(AGG.speedByCohort(idx));
  },

  trajectory(idx, s) {
    chartDepth(AGG.depth(idx));
    chartVelocity(AGG.velocityByMaturity(idx));
    chartDurability(AGG.durabilityBySource(idx));
  },

  coverage(idx, s) {
    chartGap(AGG.gapByCohort(idx));
    renderTable('tblGap', [
      { key: 'key', label: 'Branch' },
      { key: 'untapped', label: 'Untapped', num: true, bar: true },
      { key: 'base', label: 'Mature base', num: true },
      { key: 'rate', label: 'Activation', num: true, pct: true }
    ], AGG.gapSegments(idx, ['branch']), { sortKey: 'untapped' });

    renderTable('tblPriority', [
      { key: 'key', label: 'State · acquisition' },
      { key: 'headroom', label: 'Headroom', num: true, bar: true },
      { key: 'untapped', label: 'Untapped', num: true },
      { key: 'rate', label: 'Peer rate', num: true, pct: true },
      { key: 'vsAvg', label: 'vs avg', num: true, signed: true, fmt: v => `${v > 0 ? '+' : ''}${v.toFixed(1)} pt` }
    ], AGG.prioritySegments(idx, ['state', 'acquisition_channel']), { sortKey: 'headroom' });
  }
};

function render() {
  const idx = applyFilters(F);
  const s = AGG.summary(idx);
  renderKPIs(s);
  if (idx.length) PANELS[activeTab](idx, s);
  document.getElementById('footMeta').textContent =
    `${fmtInt(idx.length)} of ${fmtInt(DS.n)} customers in view · generated ${DS.meta.generated_at || '—'} · data as of ${DS.meta.as_of || '—'}`;
  requestAnimationFrame(resizeAll);
}

/* ---------------------------------------------------------------------- */
loadData().then(() => {
  const badge = document.getElementById('modeBadge');
  const sample = DS.meta.source === 'sample';
  badge.textContent = sample ? 'Sample data' : (DS.meta.mode === 'gated' ? 'Row-level' : 'Aggregate');
  badge.classList.toggle('sample', sample);
  document.getElementById('asOf').textContent =
    `${DS.meta.lookback_months || '?'}-month window · as of ${DS.meta.as_of || '—'}`;

  const warn = [];
  if (sample) warn.push('Synthetic data — not real numbers.');
  if (DS.meta.unmapped_source_count) {
    warn.push(`${DS.meta.unmapped_source_count} unmapped activation source value(s) fell into "Others" — see etl/source_map.json.`);
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
    `If data/customers.json is missing, build it first:\n\n    python etl/build.py --sample`;
});
