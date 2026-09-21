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

/* Cluster names, consultant names and Sub-Channel labels all come from the
 * warehouse and all end up inside markup we build by hand -- as text, and as
 * data- attributes a click handler reads back. Escape both. */
function escHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(v) {
  return escHtml(v).replace(/"/g, '&quot;');
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

  const body = sorted.map(r => {
    const name = String(r.name);
    const cls = [];
    if (opts.totalRow && name === opts.totalRow) cls.push('total-row');
    if (opts.highlight && name === opts.highlight) cls.push('picked-row');
    const rowCls = cls.length ? ' class="' + cls.join(' ') + '"' : '';
    return '<tr' + rowCls + '>' + columns.map(c => {
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
    const attrs = drill ? ` data-metric="${escAttr(c.metric)}" data-row="${escAttr(name)}"` : '';
    if (c.bar) {
      const w = Math.round(100 * (r[c.key] || 0) / maxes[c.key]);
      return `<td class="${cls} bar-cell"${attrs}><i style="width:${w}%"></i><span>${inner}</span></td>`;
    }
    return `<td class="${cls}"${attrs}>${inner}</td>`;
  }).join('') + '</tr>'; }).join('');

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

/* ---------------------------------------------------------------------- */
/* transposed matrix: metrics down the side, months across the top          */
/* ---------------------------------------------------------------------- */
/* Not renderTable's shape, and deliberately not sortable. The rows are a
 * sequence that reads top to bottom -- base, then activation, then what the
 * activation produced, then how it split -- and the columns are chronological.
 * Sorting either axis would destroy the only thing the table is for.
 *
 * `metrics` entries are either { section } for a divider or
 * { label, get(stats), fmt?, metric?, sub?, strong?, rate? }.
 * `columns` entries are { key, label, stats, total? }.
 */
function renderMatrix(elId, metrics, columns, opts) {
  const el = document.getElementById(elId);
  if (!el) { console.warn('renderMatrix: no element #' + elId); return; }
  opts = opts || {};
  if (!columns.length) { el.innerHTML = '<p class="muted">Nothing in range.</p>'; return; }

  const head = '<tr><th class="m-name">Metric</th>' + columns.map(c =>
    `<th class="num${c.total ? ' m-total' : ''}">${escHtml(c.label)}</th>`).join('') + '</tr>';

  const body = metrics.map(m => {
    if (m.section) {
      // The label lives in the sticky first cell, not in a colspan across the
      // whole row -- a colspan'd cell scrolls its text off to the left as soon
      // as the table is wider than the screen, which is most of the time.
      return `<tr class="m-section"><th class="m-name">${escHtml(m.section)}</th>` +
             `<td colspan="${columns.length}"></td></tr>`;
    }
    const cells = columns.map(c => {
      const v = m.get(c.stats);
      const text = (v === null || v === undefined) ? '—' : (m.fmt ? m.fmt(v) : fmtInt(v));
      let cls = 'num';
      if (c.total) cls += ' m-total';
      if (m.rate) cls += ' m-rate';
      // Percentages and per-referrer ratios are derived, not a set of rows, so
      // there is nothing honest to hand back as a CSV.
      const drill = opts.drilldown && m.metric && typeof v === 'number' && v > 0;
      if (drill) cls += ' drill';
      const attrs = drill
        ? ` data-metric="${escAttr(m.metric)}" data-col="${escAttr(c.key)}"` : '';
      return `<td class="${cls}"${attrs}>${text}</td>`;
    }).join('');
    const rowCls = m.strong ? ' class="m-strong"' : '';
    // m.label may carry a Sub-Channel colour dot, so it is trusted markup that
    // the caller built -- everything caller-side goes through escHtml first.
    return `<tr${rowCls}><th class="m-name${m.sub ? ' m-sub' : ''}">${m.label}</th>${cells}</tr>`;
  }).join('');

  el.innerHTML = `<table class="data matrix"><thead>${head}</thead><tbody>${body}</tbody></table>`;

  if (opts.drilldown) {
    el.querySelectorAll('td.drill').forEach(td => td.addEventListener('click', () => {
      const col = columns.find(c => String(c.key) === td.dataset.col);
      if (!col || !col.stats || !col.stats.rows) return;
      const picked = rowsForMetric(col.stats.rows, td.dataset.metric);
      const file = downloadCustomers(picked, [opts.label, col.label, td.dataset.metric]);
      if (file) {
        td.classList.add('drilled');
        setTimeout(() => td.classList.remove('drilled'), 900);
      }
    }));
  }
}
