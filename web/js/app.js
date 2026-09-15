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

  const toggle = document.getElementById('drillToggle');
  toggle.addEventListener('click', () => {
    drilldownOn = !drilldownOn;
    toggle.setAttribute('aria-checked', String(drilldownOn));
    toggle.querySelector('.t-label').textContent = drilldownOn ? 'On' : 'Off';
    render();
  });

  document.getElementById('resetFilters').addEventListener('click', () => {
    F.state.clear(); F.branch.clear();
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

    const detail = AGG.subChannelDetail(idx);
    chartDetail(detail);
    renderTable('tblDetail', [
      { key: 'detail', label: 'Detail' },
      { key: 'referrers', label: 'Referrers', num: true, bar: true },
      { key: 'share', label: 'Share', num: true, pct: true },
      { key: 'successful', label: 'Successful', num: true },
      { key: 'successShare', label: 'Success rate', num: true, pct: true },
      { key: 'referrals', label: 'Referrals', num: true }
    ], detail, { sortKey: 'referrers' });

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

  sales(idx, s) {
    const cfg = DS.meta.activation || { start: -3, end: 90 };
    document.getElementById('salesWindowNote').innerHTML =
      'A customer counts as <strong>activated</strong> if they gave a referral between ' +
      '<strong>' + cfg.start + '</strong> and <strong>+' + cfg.end + ' days</strong> of ' +
      'their installation &mdash; the span covering installation, commissioning, subsidy ' +
      'disbursal and the first zero bill.';

    const rows = AGG.cityTable(idx, 'city');
    const pctCol = (k, l) => ({ key: k, label: l, num: true, pct: true });
    const numCol = (k, l, metric) => ({ key: k, label: l, num: true, metric: metric || k });
    renderTable('tblCity', [
      { key: 'name', label: 'City' },
      numCol('installed', 'Installed base'),
      numCol('cx_recommended', 'Cx Recommended'),
      numCol('idv', 'IDV visits'),
      numCol('referrer_activated', 'Referrer activation', 'referrer_activated'),
      pctCol('activation_rate', 'Act %'),
      numCol('successful_activated', 'Orders activation', 'successful_activated'),
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
          ? ' <em>Downloads exclude customer and staff identity &mdash; this build is in ' +
            'public mode. Rebuild with <code>--mode gated</code> for the full sheet.</em>'
          : '')
      : '';

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

  funnel(idx, s) {
    const stages = AGG.funnelStages(idx);
    chartFunnel(stages);

    const cfg = DS.meta.funnel_config || {};
    const answered = stages.find(x => x.stage === 'Answered the survey');
    const rec = stages.find(x => x.stage === 'Cx Recommended');
    const idv = stages.find(x => x.stage === 'IDV done');
    const recOfAnswered = answered && answered.customers
      ? pct(rec ? rec.customers : 0, answered.customers) : 0;
    document.getElementById('funnelFinding').innerHTML =
      'Only <strong>' + fmtPct(answered ? answered.pct : 0) + '</strong> of the installed ' +
      'base has answered the survey, but <strong>' + fmtPct(recOfAnswered) + '</strong> of ' +
      'those who did scored ' + (cfg.min_score || 9) + '&ndash;' + (cfg.scale_max || 10) + '. ' +
      'The drop at <em>Cx Recommended</em> is mostly reach, not reluctance.' +
      (idv && idv.customers < 50
        ? ' IDV (<code>' + (cfg.idv_task_keys || []).join(', ') + '</code>, ' +
          (cfg.idv_days_before || 3) + ' days before to ' + (cfg.idv_days_after || 3) +
          ' days after installation) went live in September 2026, so it is still near zero.'
        : '');

    const npsRows = AGG.byNpsGroup(idx);
    if (!npsRows.length) {
      // Distinguish "no source yet" from "no rows matched" -- the generic
      // empty-table message would read as the latter.
      document.getElementById('tblNps').innerHTML =
        '<p class="muted">Cx Recommended is a placeholder &mdash; no source is wired up ' +
        'yet, so there is nothing to split on. This table fills in once ' +
        '<code>cx_recommended.enabled</code> is turned on in ' +
        '<code>etl/funnel_config.json</code>.</p>';
      return;
    }
    renderTable('tblNps', [
      { key: 'group', label: 'Survey answer' },
      { key: 'base', label: 'Customers', num: true, bar: true },
      { key: 'referrers', label: 'Referrers', num: true },
      { key: 'rate', label: 'Referral rate', num: true, pct: true },
      { key: 'successful', label: 'Successful', num: true },
      { key: 'successRate', label: 'Success rate', num: true, pct: true },
      { key: 'perCustomer', label: 'Referrals each', num: true, fmt: v => v.toFixed(2) }
    ], npsRows, { sortKey: 'base' });
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
  renderKPIs(s, AGG.activationSummary(idx));
  const panel = document.querySelector('.panel[data-panel="' + activeTab + '"]');
  setEmptyState(panel, idx.length === 0);
  if (idx.length) PANELS[activeTab](idx, s);
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
  const stamp = gen
    ? new Date(gen).toLocaleString('en-IN',
        { day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true })
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
