/* Drill-down: turn a clicked number into a downloadable customer list.
 *
 * The row set behind every figure on the Sales tracker is already in memory, so
 * a download is just a re-encode of rows the page has -- no round trip, and the
 * file always matches exactly what the filters were showing when it was
 * clicked.
 *
 * The identifying columns (SSEID, name, SC, Installation Champion) ship only in
 * gated mode. In public mode the build leaves them out entirely, so export
 * degrades to the non-identifying columns and says so rather than emitting a
 * file full of blanks.
 */
'use strict';

const EXPORT_COLUMNS = [
  { key: 'install_id',                  label: 'SSEID' },
  { key: 'customer_name',               label: 'Name' },
  { key: 'branch',                      label: 'Cluster' },
  { key: 'sales_channel',               label: 'Channel' },
  { key: 'city',                        label: 'City' },
  { key: 'state',                       label: 'State' },
  { key: 'order_booked_date',           label: 'Order Booked Date' },
  { key: 'hoto_date',                   label: 'HOTO Date' },
  { key: 'sc_name',                     label: 'SC Name' },
  { key: 'sc_email',                    label: 'SC Email' },
  { key: 'first_install_date',          label: 'Install Date' },
  { key: 'installation_champion',       label: 'Installation Champion' },
  { key: 'installation_champion_email', label: 'Installation Champion Email' },
  { key: 'commissioning_date',          label: 'Commissioning Date' },
  { key: 'referrer_activated',          label: 'Referrer Activation' },
  { key: 'successful_activated',        label: 'Orders Activation' },
  { key: 'leads_in_window',             label: 'Leads In Window' },
  { key: 'orders_in_window',            label: 'Orders In Window' },
  { key: 'activated_by_window',         label: 'Sub-Channel' },
  { key: 'activation_window',           label: 'Activation Window' },
  { key: 'first_timing_bucket',         label: 'First Referral Window' },
  { key: 'days_to_activation',          label: 'Days From Install To First In-Window Referral' },
  { key: 'capacity_kw',                 label: 'Capacity kW' }
];

function exportableColumns() {
  // Window-derived fields have no column of their own to check for.
  return EXPORT_COLUMNS.filter(c => DS.has(c.key) || LIVE_CELL[c.key]);
}

function missingIdentityColumns() {
  return ['install_id', 'customer_name', 'sc_name', 'installation_champion']
    .filter(k => !DS.has(k));
}

/* Window-dependent fields come from the live window, not the build's columns,
 * or a download taken at -3..+30 would carry -3..+90 numbers. */
const LIVE_CELL = {
  referrer_activated: i => (winStats().activated[i] ? 'Yes' : 'No'),
  successful_activated: i => (winStats().successful[i] ? 'Yes' : 'No'),
  leads_in_window: i => winStats().leads[i],
  orders_in_window: i => winStats().orders[i],
  activated_by_window: i => (winStats().hasFirst[i]
    ? REF.subLevels[winStats().sub[i]] : ''),
  activation_window: i => (winStats().hasFirst[i]
    ? (subWindowOf(winStats().firstDay[i],
        DS.cols.commissioning_offset ? DS.cols.commissioning_offset.v[i] : null) || '')
    : ''),
  days_to_activation: i => (winStats().hasFirst[i] ? winStats().firstDay[i] : '')
};

function cellValue(key, i) {
  if (LIVE_CELL[key]) return LIVE_CELL[key](i);
  const c = DS.cols[key];
  if (!c) return '';
  const v = c.v[i];
  if (v === null || v === undefined) return '';
  if (c.t === 'cat') return c.levels[v];
  if (c.t === 'bool') return v ? 'Yes' : 'No';
  return v;
}

/* RFC 4180: quote anything containing a comma, quote or newline, and double up
 * embedded quotes. Customer names contain commas often enough to matter. */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(indices) {
  const cols = exportableColumns();
  // The window is part of what the file means, so it travels with it.
  const lines = [csvCell('Activation window: ' + WIN.start + ' to +' + WIN.end +
                         ' days from installation'),
                 cols.map(c => csvCell(c.label)).join(',')];
  for (const i of indices) {
    lines.push(cols.map(c => csvCell(cellValue(c.key, i))).join(','));
  }
  // BOM so Excel opens UTF-8 names correctly instead of mojibake.
  return '﻿' + lines.join('\r\n');
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function downloadCustomers(indices, labelParts) {
  if (!indices || !indices.length) return;
  const csv = buildCsv(indices);
  const name = ['referral', ...labelParts.map(slug).filter(Boolean),
                new Date().toISOString().slice(0, 10)].join('_') + '.csv';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick; revoking synchronously races the download in
  // some browsers and yields a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** Rows behind one cell of any metric table.
 *
 * "sub:Sales" and "win:-3 to +3" address the mix rows on the deep-dive matrix.
 * Those have no column of their own -- they read one column, but only for
 * customers who activated, so that the split sums back to the activated count.
 */
function rowsForMetric(rows, metric) {
  const w = winStats();
  const comm = DS.cols.commissioning_offset;
  const sep = String(metric || '').indexOf(':');
  if (sep > 0) {
    const kind = metric.slice(0, sep), value = metric.slice(sep + 1);
    return rows.filter(i => w.activated[i] && (kind === 'sub'
      ? REF.subLevels[w.sub[i]] === value
      : subWindowOf(w.firstDay[i], comm ? comm.v[i] : null) === value));
  }
  const want = {
    installed: () => true,
    referrer_activated: i => w.activated[i],
    successful_activated: i => w.successful[i],
    not_referred: i => !w.activated[i],
    leads: i => w.leads[i] > 0,
    orders: i => w.orders[i] > 0,
    cx_recommended: i => DS.cols.cx_recommended && DS.cols.cx_recommended.v[i],
    idv: i => DS.cols.idv_done && DS.cols.idv_done.v[i],
    idv_scheduled: i => DS.cols.idv_scheduled && DS.cols.idv_scheduled.v[i]
  }[metric] || (() => true);
  return rows.filter(want);
}
