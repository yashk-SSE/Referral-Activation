/* ECharts builders + HTML table renderers. */
'use strict';

// The dashboard is light-only; keeping one palette avoids chart colours
// drifting away from the CSS tokens in a theme nobody reviewed.
const isDark = false;
const C = {
  text: isDark ? '#a3adba' : '#5a6470',
  textStrong: isDark ? '#e8ecf1' : '#16191d',
  axis: isDark ? '#2d343d' : '#e3e6ea',
  split: isDark ? '#232931' : '#eef0f3',
  accent: isDark ? '#6c9bec' : '#3b6fd4',
  good: isDark ? '#3fbc8a' : '#17845a',
  muted: isDark ? '#3a434e' : '#d7dce2',
  tooltipBg: isDark ? '#1c2128' : '#ffffff',
  tooltipBorder: isDark ? '#39414c' : '#cbd2da'
};

const charts = new Map();
function mount(id, option) {
  const el = document.getElementById(id);
  if (!el) { console.warn('mount: no element #' + id); return; }
  let c = charts.get(id);
  if (!c) { c = echarts.init(el, null, { renderer: 'canvas' }); charts.set(id, c); }
  c.setOption(option, { notMerge: true });
  return c;
}
function resizeAll() { charts.forEach(c => c.resize()); }
window.addEventListener('resize', resizeAll);

const BASE = () => ({
  animationDuration: 320,
  textStyle: { color: C.text, fontFamily: 'inherit', fontSize: 11 },
  grid: { left: 46, right: 16, top: 28, bottom: 34, containLabel: true },
  tooltip: {
    trigger: 'axis',
    backgroundColor: C.tooltipBg,
    borderColor: C.tooltipBorder,
    borderWidth: 1,
    textStyle: { color: C.textStrong, fontSize: 12 },
    axisPointer: { type: 'shadow', shadowStyle: { color: isDark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.03)' } }
  },
  legend: { type: 'scroll', top: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: C.text, fontSize: 11 } }
});
const AXIS_X = extra => Object.assign({
  type: 'category',
  axisLine: { lineStyle: { color: C.axis } },
  axisTick: { show: false },
  axisLabel: { color: C.text, fontSize: 10 }
}, extra || {});
const AXIS_Y = extra => Object.assign({
  type: 'value',
  axisLine: { show: false },
  axisTick: { show: false },
  splitLine: { lineStyle: { color: C.split } },
  axisLabel: { color: C.text, fontSize: 10 }
}, extra || {});

const fmtInt = n => (n === null || n === undefined) ? '—' : Math.round(n).toLocaleString();
const fmtPct = n => (n === null || n === undefined) ? '—' : `${(+n).toFixed(1)}%`;



/* ---------------------------------------------------------------------- */
/* overview                                                                */
/* ---------------------------------------------------------------------- */
function chartCohort(rows) {
  mount('chCohort', Object.assign(BASE(), {
    grid: { left: 40, right: 46, top: 30, bottom: 46, containLabel: true },
    legend: { top: 0, data: ['Customers', 'Referred'] },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = rows[p[0].dataIndex];
        return `<b>${r.cohort}</b><br/>${fmtInt(r.referrers)} of ${fmtInt(r.base)} referred` +
               `<br/><span style="color:${C.text}">${fmtPct(r.rate)} activation</span>`;
      }
    },
    xAxis: AXIS_X({ data: rows.map(r => r.cohort), axisLabel: { color: C.text, fontSize: 10, rotate: 55 } }),
    yAxis: [AXIS_Y(), AXIS_Y({ max: 100, axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 }, splitLine: { show: false } })],
    series: [
      { name: 'Customers', type: 'bar', stack: 'x', barMaxWidth: 24,
        data: rows.map(r => r.base - r.referrers), itemStyle: { color: C.muted } },
      { name: 'Referred', type: 'bar', stack: 'x', barMaxWidth: 24,
        data: rows.map(r => r.referrers), itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
      { name: 'Activation %', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none',
        data: rows.map(r => r.rate), lineStyle: { width: 2, color: C.good } }
    ]
  }));
}

/* ---------------------------------------------------------------------- */
/* activation source                                                       */
/* ---------------------------------------------------------------------- */
function chartSource(rows) {
  const d = rows.slice().sort((a, b) => a.referrers - b.referrers);
  mount('chSource', Object.assign(BASE(), {
    grid: { left: 8, right: 70, top: 14, bottom: 22, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = d[p[0].dataIndex];
        return `<b>${r.source}</b><br/>${fmtInt(r.referrers)} referrers (${fmtPct(r.share)})` +
               `<br/><span style="color:${C.text}">${fmtInt(r.referrals)} referrals</span>`;
      }
    },
    xAxis: AXIS_Y({ axisLabel: { show: false }, splitLine: { show: false } }),
    yAxis: AXIS_X({ data: d.map(r => r.source), axisLabel: { color: C.text, fontSize: 11 } }),
    series: [{
      type: 'bar', data: d.map(r => r.referrers), barMaxWidth: 22,
      itemStyle: { color: p => SOURCE_COLOR[d[p.dataIndex].source] || FALLBACK_COLOR, borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: C.text, fontSize: 10,
               formatter: p => `${fmtInt(p.value)}  (${fmtPct(d[p.dataIndex].share)})` }
    }]
  }));
}


function chartSourceShare(mix) {
  const totals = mix.cohorts.map((_, i) =>
    SOURCES.reduce((sum, s) => sum + mix.series[s][i], 0));
  mount('chSourceShare', Object.assign(BASE(), {
    grid: { left: 40, right: 14, top: 30, bottom: 46, containLabel: true },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      valueFormatter: v => fmtPct(v)
    },
    xAxis: AXIS_X({ data: mix.cohorts, axisLabel: { color: C.text, fontSize: 10, rotate: 55 } }),
    yAxis: AXIS_Y({ max: 100, axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 } }),
    series: SOURCES.map(s => ({
      name: s, type: 'line', stack: 'share', smooth: true, symbol: 'none',
      areaStyle: { color: SOURCE_COLOR[s], opacity: .85 },
      lineStyle: { width: 0 },
      emphasis: { focus: 'series' },
      data: mix.series[s].map((v, i) => totals[i] ? +(100 * v / totals[i]).toFixed(2) : 0)
    }))
  }));
}

/* ---------------------------------------------------------------------- */
/* timing                                                                  */
/* ---------------------------------------------------------------------- */
function chartTimingBuckets(rows) {
  // Short axis labels; the full bucket name is in the tooltip.
  const SHORT = ['Before install', 'Install +0-3d', 'Install +4-7d',
                 'Install +8d to comm.', 'After comm.'];
mount('chTiming', Object.assign(BASE(), {
    grid: { left: 44, right: 16, top: 20, bottom: 46, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = rows[p[0].dataIndex];
        return `<b>${r.bucket}</b><br/>${fmtInt(r.customers)} referrers` +
               `<br/><span style="color:${C.text}">${fmtPct(r.pct)} of all referrers</span>`;
      }
    },
    xAxis: AXIS_X({ data: rows.map((r, i) => SHORT[i] || r.bucket),
                    axisLabel: { color: C.text, fontSize: 10, lineHeight: 13 } }),
    yAxis: AXIS_Y(),
    series: [{
      type: 'bar', data: rows.map(r => r.customers), barMaxWidth: 60,
      itemStyle: { color: p => TIMING_COLOR[rows[p.dataIndex].bucket] || C.accent,
                   borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top', color: C.text, fontSize: 11,
               formatter: p => fmtPct(rows[p.dataIndex].pct) }
    }]
  }));
}

/* Where a customer's first referral came from on each side of installation.
 * A customer who referred both before and after appears in both series. */
function chartBeforeAfter(rows) {
  mount('chBeforeAfter', Object.assign(BASE(), {
    grid: { left: 60, right: 20, top: 30, bottom: 34, containLabel: true },
    legend: { top: 0, data: ['Before installation', 'After installation'] },
    tooltip: { trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder,
               borderWidth: 1, textStyle: { color: C.textStrong, fontSize: 12 } },
    xAxis: AXIS_Y(),
    yAxis: AXIS_X({ data: rows.map(r => r.sub_channel), axisLabel: { color: C.text, fontSize: 11 } }),
    series: [
      { name: 'Before installation', type: 'bar', data: rows.map(r => r.before),
        barMaxWidth: 13, itemStyle: { color: '#e0862c', borderRadius: [0, 3, 3, 0] } },
      { name: 'After installation', type: 'bar', data: rows.map(r => r.after),
        barMaxWidth: 13, itemStyle: { color: '#17a2a2', borderRadius: [0, 3, 3, 0] } }
    ]
  }));
}



/* ---------------------------------------------------------------------- */
/* trajectory                                                              */
/* ---------------------------------------------------------------------- */
function chartDepth(rows) {
  mount('chDepth', Object.assign(BASE(), {
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = rows[p[0].dataIndex];
        return `<b>${fmtInt(r.count)}</b> gave ${r.n}+ referrals<br/><span style="color:${C.text}">${fmtPct(r.pct)} of all referrers</span>`;
      }
    },
    xAxis: AXIS_X({ data: rows.map(r => `${r.n}+`) }),
    yAxis: AXIS_Y(),
    series: [{
      type: 'bar', data: rows.map(r => r.count), barMaxWidth: 34,
      itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] },
      label: { show: true, position: 'top', color: C.text, fontSize: 10, formatter: p => fmtPct(rows[p.dataIndex].pct) }
    }]
  }));
}



/* ---------------------------------------------------------------------- */
/* coverage gap                                                            */
/* ---------------------------------------------------------------------- */
function chartGap(rows) {
  mount('chGap', Object.assign(BASE(), {
    grid: { left: 44, right: 16, top: 30, bottom: 50, containLabel: true },
    legend: { top: 0 },
    xAxis: AXIS_X({ data: rows.map(r => r.cohort), axisLabel: { color: C.text, fontSize: 10, rotate: 55 } }),
    yAxis: AXIS_Y({ name: 'customers', nameTextStyle: { color: C.text, fontSize: 10 } }),
    series: [
      { name: 'Referrers', type: 'bar', stack: 'g', data: rows.map(r => r.referrers), itemStyle: { color: C.accent } },
      { name: 'Never referred (mature)', type: 'bar', stack: 'g', data: rows.map(r => r.mature), itemStyle: { color: '#d4506b' } },
      { name: 'Never referred (too new to judge)', type: 'bar', stack: 'g', data: rows.map(r => r.young), itemStyle: { color: C.muted, borderRadius: [3, 3, 0, 0] } }
    ]
  }));
}

/* ---------------------------------------------------------------------- */
/* tables                                                                  */
/* ---------------------------------------------------------------------- */
function renderTable(elId, columns, rows, opts) {
  const el = document.getElementById(elId);
  if (!el) { console.warn('renderTable: no element #' + elId); return; }
  opts = opts || {};
  if (!rows.length) { el.innerHTML = '<p class="muted">Nothing in range.</p>'; return; }

  const state = el._sort || { key: opts.sortKey || columns[1].key, dir: -1 };
  const sorted = rows.slice().sort((a, b) => {
    const x = a[state.key], y = b[state.key];
    if (typeof x === 'string') return state.dir * x.localeCompare(y);
    return state.dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });

  const maxes = {};
  columns.forEach(c => { if (c.bar) maxes[c.key] = Math.max(...rows.map(r => r[c.key] || 0), 1); });

  const head = columns.map(c =>
    `<th class="${c.num ? 'num' : ''}" data-key="${c.key}">${c.label}${state.key === c.key ? (state.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`
  ).join('');

  const body = sorted.map(r => '<tr>' + columns.map(c => {
    let v = r[c.key];
    let cls = c.num ? 'num' : '';
    let inner;
    if (c.fmt) inner = c.fmt(v, r);
    else if (v === null || v === undefined) inner = '—';
    else if (typeof v === 'number') inner = c.pct ? fmtPct(v) : fmtInt(v);
    else inner = String(v);
    if (c.signed && typeof v === 'number') cls += v > 0 ? ' pos' : (v < 0 ? ' neg' : '');
    // Drill-down cells carry the metric so a click can rebuild the exact row
    // set behind the number that was clicked.
    const drill = opts.drilldown && c.metric && typeof v === 'number' && v > 0;
    if (drill) cls += ' drill';
    const attrs = drill ? ` data-metric="${c.metric}" data-row="${r.name}"` : '';
    if (c.bar) {
      const w = Math.round(100 * (r[c.key] || 0) / maxes[c.key]);
      return `<td class="${cls} bar-cell"${attrs}><i style="width:${w}%"></i><span>${inner}</span></td>`;
    }
    return `<td class="${cls}"${attrs}>${inner}</td>`;
  }).join('') + '</tr>').join('');

  el.innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

  if (opts.drilldown) {
    el.querySelectorAll('td.drill').forEach(td => td.addEventListener('click', () => {
      const row = sorted.find(r => String(r.name) === td.dataset.row);
      if (!row || !row.rows) return;
      const picked = rowsForMetric(row.rows, td.dataset.metric);
      const file = downloadCustomers(picked, [row.name, td.dataset.metric]);
      if (file) {
        td.classList.add('drilled');
        setTimeout(() => td.classList.remove('drilled'), 900);
      }
    }));
  }

  el.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const key = th.dataset.key;
    el._sort = { key, dir: state.key === key ? -state.dir : -1 };
    renderTable(elId, columns, rows, opts);
  }));
}

/* ---------------------------------------------------------------------- */
/* inside Others                                                           */
/* ---------------------------------------------------------------------- */
const OTHERS_COLOR = {
  'Campaign-driven': '#17a2a2',
  'Unprompted': '#0891b2',
  'Customer app / in-app': '#8b5cf6',
  'SolarPro Partner (SPP)': '#8b5cf6',
  'Employee-led, role not captured': '#e0862c',
  'SSE employee': '#6366f1',
  'HO Team & Others': '#94a3b8',
  'Inbound cc team': '#64748b',
  'Assure customer': '#0891b2',
  'Unattributed (no role, no source)': '#b4bcc6'
};

function chartDetail(rows) {
  const d = rows.slice().sort((a, b) => a.referrers - b.referrers);
  mount('chDetail', Object.assign(BASE(), {
    grid: { left: 8, right: 74, top: 12, bottom: 20, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder,
      borderWidth: 1, textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = d[p[0].dataIndex];
        return '<b>' + r.detail + '</b><br/>' + fmtInt(r.referrers) +
               ' referrers (' + fmtPct(r.share) + ' of Others)<br/>' +
               '<span style="color:' + C.text + '">' + fmtInt(r.successful) +
               ' successful \u00b7 ' + fmtInt(r.referrals) + ' referrals</span>';
      }
    },
    xAxis: AXIS_Y({ axisLabel: { show: false }, splitLine: { show: false } }),
    yAxis: AXIS_X({ data: d.map(r => r.detail), axisLabel: { color: C.text, fontSize: 11 } }),
    series: [{
      type: 'bar', data: d.map(r => r.referrers), barMaxWidth: 20,
      itemStyle: { color: p => OTHERS_COLOR[d[p.dataIndex].detail] || '#94a3b8',
                   borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: C.text, fontSize: 10,
               formatter: p => fmtInt(p.value) + '  (' + fmtPct(d[p.dataIndex].share) + ')' }
    }]
  }));
}


/* ---------------------------------------------------------------------- */
/* funnel                                                                  */
/* ---------------------------------------------------------------------- */
function chartFunnel(rows) {
  // A horizontal bar rather than an ECharts funnel: the stages are not strictly
  // nested (a customer can be a referrer without answering the survey), and a
  // funnel shape would imply a containment that does not hold.
  mount('chFunnel', Object.assign(BASE(), {
    grid: { left: 10, right: 92, top: 10, bottom: 24, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder,
      borderWidth: 1, textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = rows[p[0].dataIndex];
        return '<b>' + r.stage + '</b><br/>' + fmtInt(r.customers) + ' customers<br/>' +
               '<span style="color:' + C.text + '">' + fmtPct(r.pct) + ' of installed</span>';
      }
    },
    xAxis: AXIS_Y({ axisLabel: { show: false }, splitLine: { show: false } }),
    yAxis: AXIS_X({ data: rows.map(r => r.stage), axisLabel: { color: C.text, fontSize: 11 } }),
    series: [{
      type: 'bar', data: rows.map(r => r.customers), barMaxWidth: 26,
      itemStyle: {
        color: p => (rows[p.dataIndex].coverage ? '#b4bcc6' : C.accent),
        borderRadius: [0, 3, 3, 0]
      },
      label: { show: true, position: 'right', color: C.text, fontSize: 11,
               formatter: p => fmtInt(p.value) + '  (' + fmtPct(rows[p.dataIndex].pct) + ')' }
    }]
  }));
}


/* ---------------------------------------------------------------------- */
/* activation window mix                                                   */
/* ---------------------------------------------------------------------- */
function chartWindowMix(mix) {
  mount('chWindowMix', Object.assign(BASE(), {
    grid: { left: 44, right: 16, top: 30, bottom: 34, containLabel: true },
    legend: { top: 0 },
    xAxis: AXIS_X({ data: mix.windows, axisLabel: { color: C.text, fontSize: 10 } }),
    yAxis: AXIS_Y({ name: 'customers activated', nameTextStyle: { color: C.text, fontSize: 10 } }),
    series: SOURCES.filter(s => (mix.series[s] || []).some(v => v > 0)).map((s, i, arr) => ({
      name: s, type: 'bar', stack: 'w', data: mix.series[s], barMaxWidth: 54,
      itemStyle: { color: SOURCE_COLOR[s] || FALLBACK_COLOR,
                   borderRadius: i === arr.length - 1 ? [3, 3, 0, 0] : 0 }
    }))
  }));
}
