/* ECharts builders + HTML table renderers. */
'use strict';

const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
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
  if (!el) return;
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
/* cohort triangle (HTML table — a heatmap with readable numbers)          */
/* ---------------------------------------------------------------------- */
/* Interpolate opaque surface -> accent rather than alpha-blending, then pick
 * the text colour from the resulting luminance. Alpha over a dark surface
 * produces dark-on-dark cells at the low end, which is unreadable. */
const HEAT_FROM = isDark ? [26, 31, 38] : [255, 255, 255];
const HEAT_TO = isDark ? [96, 146, 232] : [30, 82, 186];

function heatCell(v, max) {
  if (v === null || v === undefined) return { bg: 'transparent', fg: 'inherit' };
  const t = max > 0 ? Math.min(v / max, 1) : 0;
  const e = Math.pow(t, 0.7);
  const rgb = HEAT_FROM.map((from, i) => Math.round(from + (HEAT_TO[i] - from) * e));
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return { bg: `rgb(${rgb.join(',')})`, fg: lum > 0.58 ? '#0d2233' : '#eef4fc' };
}
const heatColor = (v, max) => heatCell(v, max).bg;

function renderTriangle(elId, tri, showMonths = 19) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!tri.rows.length) { el.innerHTML = '<p class="muted">No cohorts in range.</p>'; return; }

  let max = 0;
  tri.rows.forEach(r => r.cells.forEach(c => { if (c !== null && c > max) max = c; }));

  const months = tri.months.slice(0, showMonths);
  const head = ['<tr><th class="row-h">Cohort</th><th class="row-h">n</th>']
    .concat(months.map(m => `<th>${m}m</th>`)).concat('</tr>').join('');

  const body = tri.rows.map(r => {
    const cells = months.map(m => {
      const v = r.cells[m];
      if (v === null || v === undefined) return '<td class="empty"></td>';
      const { bg, fg } = heatCell(v, max);
      return `<td style="background:${bg};color:${fg}" title="${r.cohort} · month ${m} · ${fmtPct(v)} of ${r.size}">${v.toFixed(0)}</td>`;
    }).join('');
    return `<tr><th class="row-h">${r.cohort}</th><td class="n">${fmtInt(r.size)}</td>${cells}</tr>`;
  }).join('');

  el.innerHTML =
    `<table class="tri"><thead>${head}</thead><tbody>${body}</tbody></table>
     <div class="tri-legend">
       <span>lower</span>
       <i style="background:${heatColor(max * 0.1, max)}"></i>
       <i style="background:${heatColor(max * 0.35, max)}"></i>
       <i style="background:${heatColor(max * 0.6, max)}"></i>
       <i style="background:${heatColor(max * 0.85, max)}"></i>
       <i style="background:${heatColor(max, max)}"></i>
       <span>higher &nbsp;·&nbsp; blank = cohort has not reached this age yet</span>
     </div>`;
}

/* ---------------------------------------------------------------------- */
/* overview                                                                */
/* ---------------------------------------------------------------------- */
function chartIndexed(rows, atMonth) {
  const shown = rows.filter(r => !r.partial);
  mount('chIndexed', Object.assign(BASE(), {
    grid: { left: 40, right: 14, top: 30, bottom: 46, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = shown[p[0].dataIndex];
        return `<b>${r.cohort}</b><br/>${fmtPct(r.value)} activated by month ${atMonth}<br/><span style="color:${C.text}">base ${fmtInt(r.size)}</span>`;
      }
    },
    xAxis: AXIS_X({ data: shown.map(r => r.cohort), axisLabel: { color: C.text, fontSize: 10, rotate: 55 } }),
    yAxis: AXIS_Y({ axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 } }),
    series: [{
      type: 'line', smooth: true, showSymbol: shown.length < 30, symbolSize: 5,
      data: shown.map(r => r.value),
      lineStyle: { width: 2, color: C.accent },
      itemStyle: { color: C.accent },
      areaStyle: { color: isDark ? 'rgba(108,155,236,.13)' : 'rgba(59,111,212,.09)' }
    }]
  }));
}

function chartVolume(rows) {
  mount('chVolume', Object.assign(BASE(), {
    grid: { left: 40, right: 46, top: 30, bottom: 46, containLabel: true },
    legend: { top: 0, data: ['Base', 'Referrers', 'Rate'] },
    xAxis: AXIS_X({ data: rows.map(r => r.cohort), axisLabel: { color: C.text, fontSize: 10, rotate: 55 } }),
    yAxis: [AXIS_Y(), AXIS_Y({ axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 }, splitLine: { show: false } })],
    series: [
      { name: 'Base', type: 'bar', stack: 'x', data: rows.map(r => r.base - r.referrers), itemStyle: { color: C.muted, borderRadius: [0, 0, 0, 0] }, barMaxWidth: 26 },
      { name: 'Referrers', type: 'bar', stack: 'x', data: rows.map(r => r.referrers), itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 26 },
      { name: 'Rate', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none', data: rows.map(r => r.rate), lineStyle: { width: 2, color: C.good } }
    ]
  }));
}

/* ---------------------------------------------------------------------- */
/* activation source                                                       */
/* ---------------------------------------------------------------------- */
function chartSourceMix(mix) {
  mount('chSourceMix', Object.assign(BASE(), {
    grid: { left: 44, right: 16, top: 30, bottom: 52, containLabel: true },
    xAxis: AXIS_X({ data: mix.cohorts, axisLabel: { color: C.text, fontSize: 10, rotate: 55 } }),
    yAxis: AXIS_Y({ name: 'new referrers', nameTextStyle: { color: C.text, fontSize: 10 }, nameGap: 14 }),
    series: SOURCES.map((s, i) => ({
      name: s, type: 'bar', stack: 'src', data: mix.series[s],
      itemStyle: { color: SOURCE_COLOR[s], borderRadius: i === SOURCES.length - 1 ? [3, 3, 0, 0] : 0 },
      barMaxWidth: 28
    }))
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
/* geography                                                               */
/* ---------------------------------------------------------------------- */
function chartState(rows, avg) {
  const d = rows.slice().sort((a, b) => a.rate - b.rate);
  mount('chState', Object.assign(BASE(), {
    grid: { left: 8, right: 56, top: 16, bottom: 24, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = d[p[0].dataIndex];
        return `<b>${r.key}</b><br/>${fmtPct(r.rate)} activated<br/><span style="color:${C.text}">${fmtInt(r.referrers)} of ${fmtInt(r.base)}</span>`;
      }
    },
    xAxis: AXIS_Y({ axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 } }),
    yAxis: AXIS_X({ data: d.map(r => r.key), axisLabel: { color: C.text, fontSize: 11 } }),
    series: [{
      type: 'bar', data: d.map(r => r.rate), barMaxWidth: 18,
      itemStyle: { color: p => d[p.dataIndex].rate >= avg ? C.accent : C.muted, borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: C.text, fontSize: 10, formatter: p => `${fmtPct(p.value)}  (n=${fmtInt(d[p.dataIndex].base)})` },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: C.good, type: 'dashed', width: 1 },
        label: { formatter: `avg ${fmtPct(avg)}`, color: C.good, fontSize: 10, position: 'end' },
        data: [{ xAxis: avg }]
      }
    }]
  }));
}

function chartBranchScatter(rows, avg) {
  mount('chBranchScatter', Object.assign(BASE(), {
    grid: { left: 46, right: 20, top: 24, bottom: 40, containLabel: true },
    legend: { show: false },
    tooltip: {
      trigger: 'item', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => `<b>${p.data[2]}</b><br/>base ${fmtInt(p.data[0])}<br/>${fmtPct(p.data[1])} activated<br/><span style="color:${C.text}">${fmtInt(p.data[3])} untapped</span>`
    },
    xAxis: AXIS_Y({ name: 'base size', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: C.text, fontSize: 10 } }),
    yAxis: AXIS_Y({ name: 'activation %', nameTextStyle: { color: C.text, fontSize: 10 }, axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 } }),
    series: [{
      type: 'scatter',
      symbolSize: d => Math.max(6, Math.min(30, Math.sqrt(d[3]) * 1.7)),
      data: rows.map(r => [r.base, r.rate, r.key, r.base - r.referrers]),
      itemStyle: {
        color: p => p.data[1] >= avg ? 'rgba(59,111,212,.62)' : 'rgba(212,80,107,.62)',
        borderColor: isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.10)'
      },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: C.good, type: 'dashed', width: 1 },
        label: { formatter: `avg ${fmtPct(avg)}`, color: C.good, fontSize: 10 },
        data: [{ yAxis: avg }]
      }
    }]
  }));
}

/* ---------------------------------------------------------------------- */
/* timing                                                                  */
/* ---------------------------------------------------------------------- */
function chartTiming(rows) {
  mount('chTiming', Object.assign(BASE(), {
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => `<b>${rows[p[0].dataIndex].label}</b><br/>${fmtInt(p[0].value)} first referrals`
    },
    xAxis: AXIS_X({ data: rows.map(r => r.label), axisLabel: { color: C.text, fontSize: 9, rotate: 50 } }),
    yAxis: AXIS_Y(),
    series: [{
      type: 'bar', data: rows.map(r => r.count), barMaxWidth: 22,
      itemStyle: { color: p => rows[p.dataIndex].pre ? '#e0862c' : C.accent, borderRadius: [3, 3, 0, 0] }
    }]
  }));
}

function chartPrePost(rows) {
  mount('chPrePost', Object.assign(BASE(), {
    grid: { left: 40, right: 16, top: 30, bottom: 40, containLabel: true },
    legend: { top: 0 },
    tooltip: { trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1, textStyle: { color: C.textStrong, fontSize: 12 } },
    xAxis: AXIS_X({ data: rows.map(r => `${r.group}\n(n=${fmtInt(r.n)})`), axisLabel: { color: C.text, fontSize: 10, lineHeight: 14 } }),
    yAxis: AXIS_Y(),
    series: [
      { name: 'Avg referrals each', type: 'bar', data: rows.map(r => r.avgReferrals), barMaxWidth: 40, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
      { name: 'Repeat rate %', type: 'bar', data: rows.map(r => r.repeatRate), barMaxWidth: 40, itemStyle: { color: '#8b5cf6', borderRadius: [3, 3, 0, 0] } },
      { name: 'Referral conversion %', type: 'bar', data: rows.map(r => r.convRate), barMaxWidth: 40, itemStyle: { color: '#17a2a2', borderRadius: [3, 3, 0, 0] } }
    ]
  }));
}

function chartSpeed(rows) {
  mount('chSpeed', Object.assign(BASE(), {
    legend: { show: false },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 },
      formatter: p => {
        const r = rows[p[0].dataIndex];
        return `<b>${r.cohort}</b><br/>median ${fmtInt(r.median)} days to first referral<br/><span style="color:${C.text}">${fmtInt(r.n)} referrers</span>`;
      }
    },
    xAxis: AXIS_X({ data: rows.map(r => r.cohort), axisLabel: { color: C.text, fontSize: 10, rotate: 55 } }),
    yAxis: AXIS_Y({ name: 'days', nameTextStyle: { color: C.text, fontSize: 10 } }),
    series: [{
      type: 'line', smooth: true, symbolSize: 5, data: rows.map(r => r.median),
      lineStyle: { width: 2, color: '#8b5cf6' }, itemStyle: { color: '#8b5cf6' }
    }]
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

function chartVelocity(rows) {
  mount('chVelocity', Object.assign(BASE(), {
    grid: { left: 40, right: 44, top: 30, bottom: 34, containLabel: true },
    legend: { top: 0 },
    xAxis: AXIS_X({ data: rows.map(r => r.label), name: 'time on base', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: C.text, fontSize: 10 } }),
    yAxis: [AXIS_Y(), AXIS_Y({ axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 }, splitLine: { show: false } })],
    series: [
      { name: 'Referrals per referrer', type: 'bar', data: rows.map(r => r.perReferrer), barMaxWidth: 30, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
      { name: 'Referrals per customer', type: 'bar', data: rows.map(r => r.perCustomer), barMaxWidth: 30, itemStyle: { color: '#8b5cf6', borderRadius: [3, 3, 0, 0] } },
      { name: 'Activation rate', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'circle', symbolSize: 5, data: rows.map(r => r.rate), lineStyle: { width: 2, color: C.good }, itemStyle: { color: C.good } }
    ]
  }));
}

function chartDurability(rows) {
  mount('chDurability', Object.assign(BASE(), {
    grid: { left: 60, right: 20, top: 30, bottom: 30, containLabel: true },
    legend: { top: 0 },
    tooltip: {
      trigger: 'axis', backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, borderWidth: 1,
      textStyle: { color: C.textStrong, fontSize: 12 }, valueFormatter: v => fmtPct(v)
    },
    xAxis: AXIS_Y({ max: 100, axisLabel: { formatter: '{value}%', color: C.text, fontSize: 10 } }),
    yAxis: AXIS_X({ data: rows.map(r => r.source), axisLabel: { color: C.text, fontSize: 11 } }),
    series: [
      { name: 'One and done', type: 'bar', stack: 'd', data: rows.map(r => +(100 * r.one / r.total).toFixed(1)), itemStyle: { color: C.muted, borderRadius: [3, 0, 0, 3] } },
      { name: 'Gave 2', type: 'bar', stack: 'd', data: rows.map(r => +(100 * r.two / r.total).toFixed(1)), itemStyle: { color: '#8b5cf6' } },
      { name: 'Gave 3+', type: 'bar', stack: 'd', data: rows.map(r => +(100 * r.three / r.total).toFixed(1)), itemStyle: { color: C.accent, borderRadius: [0, 3, 3, 0] } }
    ]
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
  if (!el) return;
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
    if (c.bar) {
      const w = Math.round(100 * (r[c.key] || 0) / maxes[c.key]);
      return `<td class="${cls} bar-cell"><i style="width:${w}%"></i><span>${inner}</span></td>`;
    }
    return `<td class="${cls}">${inner}</td>`;
  }).join('') + '</tr>').join('');

  el.innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  el.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const key = th.dataset.key;
    el._sort = { key, dir: state.key === key ? -state.dir : -1 };
    renderTable(elId, columns, rows, opts);
  }));
}
