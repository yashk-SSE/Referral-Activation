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
  { key: 'referrer_activated',          label: 'Referrer Activated' },
  { key: 'successful_activated',        label: 'Successful Activated' },
  { key: 'leads_in_window',             label: 'Leads In Window' },
  { key: 'orders_in_window',            label: 'Orders In Window' },
  { key: 'activated_by_window',         label: 'Sub-Channel' },
  { key: 'first_timing_bucket',         label: 'Activation Window' },
  { key: 'days_to_activation',          label: 'Days From Install To First Referral' },
  { key: 'capacity_kw',                 label: 'Capacity kW' }
];

function exportableColumns() {
  return EXPORT_COLUMNS.filter(c => DS.has(c.key));
}

function missingIdentityColumns() {
  return ['install_id', 'customer_name', 'sc_name', 'installation_champion']
    .filter(k => !DS.has(k));
}

function cellValue(key, i) {
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
  const lines = [cols.map(c => csvCell(c.label)).join(',')];
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

/** Rows behind one cell of the city table. */
function rowsForMetric(rows, metric) {
  const want = {
    installed: () => true,
    referrer_activated: i => DS.cols.referrer_activated.v[i],
    successful_activated: i => DS.cols.successful_activated.v[i],
    not_referred: i => !DS.cols.referrer_activated.v[i],
    leads: i => (DS.cols.leads_in_window.v[i] || 0) > 0,
    orders: i => (DS.cols.orders_in_window.v[i] || 0) > 0,
    cx_recommended: i => DS.cols.cx_recommended && DS.cols.cx_recommended.v[i],
    idv: i => DS.cols.idv_done && DS.cols.idv_done.v[i]
  }[metric] || (() => true);
  return rows.filter(want);
}
