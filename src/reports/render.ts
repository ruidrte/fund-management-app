/**
 * Report renderer.
 *
 * Emits one self-contained HTML file: inline CSS, hand-emitted SVG, no CDN and
 * no network at render time or view time. A quarterly report has to open from a
 * local disk, out of an email attachment, years from now — so it carries
 * everything it needs.
 *
 * The renderer holds no fund-specific content. Every name, figure and sentence
 * comes from the analysis it is given.
 */

import type { QuarterView } from '../engine';
import type { ExposureBreakdown } from '../engine/exposure';
import type { Bridge } from '../engine/bridge';
import { formatPeriod } from '../domain/period';
import type { ReportLayout, Section } from './layouts';
import {
  money, multiple, percent, signedMoney,
  PROVENANCE_LABEL, formatTimestamp, formatDate,
} from '../components/common/format';

export interface RenderOptions {
  layout: ReportLayout;
  view: QuarterView;
  /** Shown in the footer so a reader can tell where the numbers came from. */
  sourceLabel: string;
  preparedBy?: string;
}

export function renderReport({ layout, view, sourceLabel, preparedBy }: RenderOptions): string {
  const vehicle = view.vehicles[0];
  const title = `${vehicle?.shortName ?? view.scope.clientId} — ${formatPeriod(view.period)}`;

  const body = layout.sections.map((section) => renderSection(section, view)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(layout.name)}</title>
<style>${STYLES}</style>
</head>
<body>
<main class="page">
${body}
<footer class="foot">
  <p>${esc(layout.name)} · ${esc(vehicle?.name ?? '')} · ${esc(formatPeriod(view.period))} · presented in ${esc(view.currency)}</p>
  <p>Generated ${esc(formatTimestamp(new Date().toISOString()))} from ${esc(sourceLabel)}${preparedBy ? ` by ${esc(preparedBy)}` : ''}.
     ${view.scope.knowledgeDate
       ? `Reproduces the position as known at ${esc(formatTimestamp(view.scope.knowledgeDate))}; later restatements are excluded.`
       : 'Reflects everything known at the time of generation.'}</p>
  <p>${view.checks.passed} identity checks passed, ${view.checks.failed} failed, ${view.checks.skipped} skipped for want of inputs.</p>
</footer>
</main>
</body>
</html>`;
}

function renderSection(section: Section, view: QuarterView): string {
  const heading = section.title ? `<h2>${esc(section.title)}</h2>` : '';
  const intro = section.intro ? `<p class="intro">${esc(section.intro)}</p>` : '';
  const content = sectionContent(section, view);
  if (!content) return '';
  if (section.id === 'cover') return content;
  return `<section class="block">${heading}${intro}${content}</section>`;
}

function sectionContent(section: Section, view: QuarterView): string {
  switch (section.id) {
    case 'cover': return cover(view);
    case 'summary': return summary(view);
    case 'kpi-gross': return grossKpis(view);
    case 'kpi-net': return netKpis(view);
    case 'nav-bridge': return bridgeBlock(view.bridges.portfolioNav);
    case 'commitments-bridge':
      // A direct fund with no undrawn commitment has nothing to say here.
      return view.gross.totals.commitments > view.gross.totals.drawn
        ? bridgeBlock(view.bridges.commitments)
        : '';
    case 'product-bridge': return bridgeBlock(view.bridges.productNav);
    case 'nav-components': return navComponents(view);
    case 'portfolio-register': return register(view);
    case 'drivers': return drivers(view);
    case 'allocation': return allocation(view);
    case 'currency': return breakdownBlock(view.exposure.currency, view);
    case 'look-through': return lookThrough(view);
    case 'capital-accounts': return capitalAccounts(view);
    case 'coverage': return coverage(view);
    case 'checks': return checks(view);
    case 'conventions': return conventions(view);
    default: return '';
  }
}

/* ---------------------------------------------------------------- sections */

function cover(view: QuarterView): string {
  const vehicle = view.vehicles[0];
  const status = view.isFinal
    ? '<span class="flag flag-good">Final</span>'
    : view.gross.coverage.publishable
      ? '<span class="flag flag-draft">Draft — not all data received</span>'
      : '<span class="flag flag-stop">Below coverage floor — do not issue</span>';

  return `<header class="cover">
  <p class="eyebrow">${esc(vehicle?.manager ?? '')}</p>
  <h1>${esc(vehicle?.name ?? 'Consolidated')}</h1>
  <p class="lede">${esc(formatPeriod(view.period))} · ${esc(vehicle ? formatDate(periodEnd(view)) : '')} · presented in ${esc(view.currency)}</p>
  <p>${status}</p>
  ${view.scope.knowledgeDate
    ? `<p class="asat">Historical view — reproduces the position as known at ${esc(formatTimestamp(view.scope.knowledgeDate))}.</p>`
    : ''}
</header>`;
}

function periodEnd(view: QuarterView): string {
  const [year, quarter] = view.period.split('Q');
  const days = { '1': '03-31', '2': '06-30', '3': '09-30', '4': '12-31' }[quarter] ?? '12-31';
  return `${year}-${days}`;
}

function summary(view: QuarterView): string {
  const qualifications = view.qualifications.length > 0
    ? `<ul class="quals">${view.qualifications.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>`
    : '';
  return `<p class="summary">${esc(view.summary)}</p>${qualifications}`;
}

function grossKpis(view: QuarterView): string {
  const t = view.gross.totals;
  return kpiGrid([
    ['Portfolio net asset value', money(t.nav, view.currency), `${signedMoney(t.nav - t.navPrior, view.currency)} on the quarter`],
    ['Commitments', money(t.commitments, view.currency), `${percent(t.percentInvested)} drawn`],
    ['Undrawn', money(t.undrawn, view.currency), `${money(t.openCommitment, view.currency)} open including recallable`],
    ['Distributed', money(t.distributed, view.currency), `${money(t.distributionsInPeriod, view.currency)} this quarter`],
    ['TVPI', multiple(t.multiples.tvpi), `DPI ${multiple(t.multiples.dpi)} · RVPI ${multiple(t.multiples.rvpi)}`],
    ['IRR', percent(t.irr), 'Since inception, money-weighted'],
  ], view.gross.provenance);
}

function netKpis(view: QuarterView): string {
  const net = view.net.product;
  return kpiGrid([
    ['Net asset value', money(net.components.vehicleNav, view.currency),
      `${signedMoney(net.components.vehicleNav - net.componentsPrior.vehicleNav, view.currency)} on the quarter`],
    ['Investor commitments', money(net.commitment, view.currency), `${percent(net.percentCalled)} called`],
    ['Undrawn', money(net.undrawn, view.currency), `${money(net.calledInPeriod, view.currency)} called this quarter`],
    ['Distributed', money(net.distributed, view.currency), `${money(net.distributedInPeriod, view.currency)} this quarter`],
    ['Net TVPI', multiple(net.multiples.tvpi), `DPI ${multiple(net.multiples.dpi)} · RVPI ${multiple(net.multiples.rvpi)}`],
    ['Net IRR', percent(net.irr), `After ${money(net.feesCumulative, view.currency)} of fees and expenses`],
  ], net.provenance);
}

function kpiGrid(items: Array<[string, string, string]>, provenance: string): string {
  const cells = items.map(([label, value, note]) =>
    `<div class="kpi"><p class="kpi-label">${esc(label)}</p><p class="kpi-value">${esc(value)}</p><p class="kpi-note">${esc(note)}</p></div>`,
  ).join('');
  return `<div class="kpi-grid">${cells}</div>${provenanceLine(provenance)}`;
}

function bridgeBlock(bridge: Bridge): string {
  const rows = bridge.steps.map((step) => `<tr class="${step.type}">
    <td>${esc(step.label)}</td>
    <td class="num">${esc(step.type === 'anchor' ? money(step.value, bridge.currency) : signedMoney(step.value, bridge.currency))}</td>
    <td class="note">${esc(step.note ?? '')}</td>
  </tr>`).join('');

  const warning = bridge.closes
    ? ''
    : `<p class="stop">This bridge does not close — residual ${esc(money(bridge.residual, bridge.currency))}. The figures above are internally inconsistent and must not be issued.</p>`;

  return `${waterfallSvg(bridge)}
<table class="grid">
  <thead><tr><th>Step</th><th class="num">${esc(bridge.currency)}</th><th>Note</th></tr></thead>
  <tbody>${rows}</tbody>
</table>${warning}${provenanceLine(bridge.provenance)}`;
}

/**
 * Hand-emitted waterfall. Anchors sit on the baseline, deltas float between the
 * running totals, and the value axis is truncated so a quarterly step stays
 * legible against a large base — which the caption then says out loud.
 */
function waterfallSvg(bridge: Bridge): string {
  const width = 680;
  const height = 220;
  const margin = { top: 24, right: 12, bottom: 46, left: 74 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  let running = 0;
  const bars = bridge.steps.map((step) => {
    if (step.type === 'anchor') {
      running = step.value;
      return { step, from: 0, to: step.value };
    }
    const from = running;
    running += step.value;
    return { step, from, to: running };
  });

  // An anchor contributes only its own value: its notional foot at zero would
  // drag the axis to zero and squash every delta against a large base.
  const values = bars.flatMap((b) => (b.step.type === 'anchor' ? [b.to] : [b.from, b.to]));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || Math.abs(rawMax) || 1;
  const floor = rawMin > 0 ? rawMin - span * 0.35 : Math.min(0, rawMin - span * 0.35);
  const max = rawMax + span * 0.18;
  const truncated = floor > 0;

  const y = (v: number) => margin.top + plotH - ((v - floor) / (max - floor)) * plotH;
  const band = plotW / bars.length;
  const barW = Math.min(56, band * 0.58);

  const gridlines = Array.from({ length: 5 }, (_, i) => floor + ((max - floor) / 4) * i)
    .map((tick) => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" class="grid-line"/>
      <text x="${margin.left - 8}" y="${y(tick).toFixed(1)}" class="axis" text-anchor="end" dominant-baseline="middle">${esc(money(tick, bridge.currency, 0))}</text>`)
    .join('');

  const marks = bars.map((bar, index) => {
    const centre = margin.left + band * index + band / 2;
    const isAnchor = bar.step.type === 'anchor';
    const base = isAnchor ? floor : bar.from;
    const top = y(Math.max(base, bar.to));
    const bottom = y(Math.min(base, bar.to));
    const h = Math.max(2, bottom - top);
    const cls = isAnchor ? 'bar-anchor' : bar.to >= bar.from ? 'bar-up' : 'bar-down';
    const connector = index < bars.length - 1
      ? `<line x1="${(centre + barW / 2).toFixed(1)}" x2="${(margin.left + band * (index + 1) + band / 2 - barW / 2).toFixed(1)}" y1="${y(bar.to).toFixed(1)}" y2="${y(bar.to).toFixed(1)}" class="connector"/>`
      : '';
    const label = isAnchor ? money(bar.step.value, bridge.currency) : signedMoney(bar.step.value, bridge.currency);
    const caption = bar.step.label.length > 18 ? `${bar.step.label.slice(0, 17)}…` : bar.step.label;

    return `<rect x="${(centre - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" class="${cls}"/>
      ${connector}
      <text x="${centre.toFixed(1)}" y="${(top - 6).toFixed(1)}" class="bar-value" text-anchor="middle">${esc(label)}</text>
      <text x="${centre.toFixed(1)}" y="${(height - margin.bottom + 16).toFixed(1)}" class="axis" text-anchor="middle">${esc(caption)}</text>`;
  }).join('');

  return `<figure class="chart">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(bridge.label)}">
${gridlines}${marks}
<line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotH}" y2="${margin.top + plotH}" class="axis-line"/>
</svg>
${truncated ? '<figcaption>Value axis truncated so quarterly steps stay legible against the base.</figcaption>' : ''}
</figure>`;
}

function navComponents(view: QuarterView): string {
  const c = view.net.product.components;
  const rows: Array<[string, number, boolean]> = [
    ['Portfolio net asset value', c.portfolio, false],
    ['Cash and equivalents', c.cash, true],
    ['Other assets and receivables', c.otherAssets, true],
    ['Current liabilities', -c.currentLiabilities, true],
    ['Accrued fees and expenses', -c.accruedExpenses, true],
  ];
  const body = rows.map(([label, value, signed]) =>
    `<tr><td>${esc(label)}</td><td class="num">${esc(signed ? signedMoney(value, view.currency) : money(value, view.currency))}</td></tr>`,
  ).join('');

  return `<table class="grid">
  <thead><tr><th>Component</th><th class="num">${esc(view.currency)}</th></tr></thead>
  <tbody>${body}</tbody>
  <tfoot><tr><td>Net asset value</td><td class="num">${esc(money(c.vehicleNav, view.currency))}</td></tr></tfoot>
</table>${view.net.product.balanceSheetEstimated
  ? '<p class="caveat">No balance sheet was filed for this period; the last available one is carried forward.</p>'
  : ''}`;
}

function register(view: QuarterView): string {
  const rows = [...view.gross.positions]
    .sort((a, b) => b.nav - a.nav)
    .map((p) => `<tr>
      <td>${esc(p.position.name)}<span class="sub">${esc(`${p.position.manager ?? ''} · ${p.position.subAssetClass ?? p.position.assetClass} · ${p.position.vintage}`)}</span></td>
      <td>${esc(p.position.currency)}</td>
      <td class="num">${esc(money(p.commitment, view.currency))}</td>
      <td class="num">${esc(money(p.drawn, view.currency))}</td>
      <td class="num">${esc(money(p.distributed, view.currency))}</td>
      <td class="num">${esc(money(p.nav, view.currency))}</td>
      <td class="num">${esc(multiple(p.multiples.tvpi))}</td>
      <td class="num">${esc(percent(p.irr))}</td>
      <td>${provenanceChip(p.provenance)}</td>
    </tr>`).join('');

  const t = view.gross.totals;
  return `<table class="grid">
  <thead><tr>
    <th>Holding</th><th>CCY</th>
    <th class="num">Commitment</th><th class="num">Drawn</th><th class="num">Distributed</th>
    <th class="num">NAV</th><th class="num">TVPI</th><th class="num">IRR</th><th>Basis</th>
  </tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td>Total</td><td></td>
    <td class="num">${esc(money(t.commitments, view.currency))}</td>
    <td class="num">${esc(money(t.drawn, view.currency))}</td>
    <td class="num">${esc(money(t.distributed, view.currency))}</td>
    <td class="num">${esc(money(t.nav, view.currency))}</td>
    <td class="num">${esc(multiple(t.multiples.tvpi))}</td>
    <td class="num">${esc(percent(t.irr))}</td><td></td>
  </tr></tfoot>
</table><p class="caveat">Amounts translated into ${esc(view.currency)}: balances at the period closing rate, flows at the rate of their own date.</p>`;
}

function drivers(view: QuarterView): string {
  const sorted = [...view.gross.positions].sort((a, b) => b.valueChange - a.valueChange);
  const gains = sorted.filter((p) => p.valueChange > 0).slice(0, 5);
  const declines = sorted.filter((p) => p.valueChange < 0).slice(-5).reverse();
  const fx = [...view.gross.positions]
    .filter((p) => Math.abs(p.fxEffect) > 0.5)
    .sort((a, b) => Math.abs(b.fxEffect) - Math.abs(a.fxEffect))
    .slice(0, 5);

  const list = (items: typeof gains, field: 'valueChange' | 'fxEffect') =>
    items.length === 0
      ? '<p class="caveat">None in this quarter.</p>'
      : `<ul class="drivers">${items.map((p) =>
          `<li><span>${esc(p.position.name)}</span><span class="num">${esc(signedMoney(p[field], view.currency))}</span></li>`,
        ).join('')}</ul>`;

  return `<div class="columns">
  <div><h3>Largest value gains</h3>${list(gains, 'valueChange')}</div>
  <div><h3>Largest value declines</h3>${list(declines, 'valueChange')}</div>
  <div><h3>Largest currency effects</h3>${list(fx, 'fxEffect')}
    <p class="caveat">Total translation effect ${esc(signedMoney(view.gross.totals.fxEffect, view.currency))}.</p></div>
</div>`;
}

function allocation(view: QuarterView): string {
  return ['subAssetClass', 'region', 'vintage']
    .map((key) => view.exposure[key])
    .filter((b): b is ExposureBreakdown => Boolean(b) && b.slices.length > 0)
    .map((b) => `<h3>${esc(dimensionLabel(b.dimension))}</h3>${breakdownBlock(b, view)}`)
    .join('');
}

function lookThrough(view: QuarterView): string {
  const entries = Object.values(view.lookThrough).filter((b) => b.slices.length > 0);
  if (entries.length === 0) {
    return '<p class="caveat">No asset-level data has been collected for this portfolio, so exposure is available only at holding level.</p>';
  }
  return entries
    .map((b) => `<h3>${esc(dimensionLabel(b.dimension))}</h3>${breakdownBlock(b, view)}`)
    .join('');
}

/**
 * Bars plus a table, always. Three of the categorical steps sit below 3:1
 * against a light surface, so the printed share is what carries the value and
 * the colour carries only identity.
 */
function breakdownBlock(breakdown: ExposureBreakdown, view: QuarterView): string {
  const slices = [...breakdown.slices].sort((a, b) => b.weight - a.weight).slice(0, 8);
  const largest = Math.max(...slices.map((s) => s.weight), 0.0001);

  const bars = slices.map((slice, index) => `<li>
    <div class="bar-row">
      <span class="swatch" style="background:var(--series-${Math.min(index + 1, 8)})"></span>
      <span class="bar-label">${esc(slice.label)}</span>
      <span class="bar-figures num">${esc(money(slice.value, breakdown.currency))} · ${esc(percent(slice.weight))}</span>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${((slice.weight / largest) * 100).toFixed(1)}%;background:var(--series-${Math.min(index + 1, 8)})"></div></div>
  </li>`).join('');

  const rows = breakdown.slices.map((slice) =>
    `<tr><td>${esc(slice.label)}</td><td class="num">${esc(money(slice.value, breakdown.currency))}</td><td class="num">${esc(percent(slice.weight))}</td><td class="num">${esc(slice.priorWeight === undefined ? '—' : percent(slice.priorWeight))}</td></tr>`,
  ).join('');

  return `<ul class="bars">${bars}</ul>
<table class="grid compact">
  <thead><tr><th>Category</th><th class="num">${esc(view.currency)}</th><th class="num">Share</th><th class="num">Prior</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p class="caveat">${esc(basisNote(breakdown))}${
  breakdown.coverage < 0.995 ? ` ${esc(percent(1 - breakdown.coverage, 0))} unclassified.` : ''}</p>`;
}

function basisNote(breakdown: ExposureBreakdown): string {
  if (breakdown.basis !== 'look-through') {
    return 'Measured on holding attributes — no look-through available.';
  }
  const base = 'Look-through to underlying assets, at the vehicle’s economic share.';
  if (!breakdown.benchmarkTotal || breakdown.benchmarkTotal <= 0) return base;
  const share = breakdown.total / breakdown.benchmarkTotal;
  if (share > 0.98) return base;
  return `${base} Asset detail covers ${money(breakdown.total, breakdown.currency)} of ${money(breakdown.benchmarkTotal, breakdown.currency)} portfolio net asset value (${percent(share, 0)}); the remainder is fund-level cash, undeployed capital and holdings with no asset data.`;
}

function capitalAccounts(view: QuarterView): string {
  const rows = view.net.investors.map((i) => `<tr>
    <td>${esc(i.investor.name)}<span class="sub">${esc(i.investor.type)}</span></td>
    <td class="num">${esc(money(i.commitment, view.currency))}</td>
    <td class="num">${esc(money(i.called, view.currency))}</td>
    <td class="num">${esc(money(i.undrawn, view.currency))}</td>
    <td class="num">${esc(money(i.distributed, view.currency))}</td>
    <td class="num">${esc(money(i.nav, view.currency))}</td>
    <td class="num">${esc(percent(i.ownership))}</td>
    <td class="num">${esc(multiple(i.multiples.tvpi))}</td>
    <td>${i.allocated ? '<span class="chip chip-warning">Allocated</span>' : provenanceChip(i.provenance)}</td>
  </tr>`).join('');

  const anyAllocated = view.net.investors.some((i) => i.allocated);

  return `<table class="grid">
  <thead><tr>
    <th>Investor</th><th class="num">Commitment</th><th class="num">Called</th><th class="num">Undrawn</th>
    <th class="num">Distributed</th><th class="num">NAV</th><th class="num">Share</th><th class="num">TVPI</th><th>Basis</th>
  </tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td>Total</td>
    <td class="num">${esc(money(sum(view.net.investors.map((i) => i.commitment)), view.currency))}</td>
    <td class="num">${esc(money(sum(view.net.investors.map((i) => i.called)), view.currency))}</td>
    <td class="num">${esc(money(sum(view.net.investors.map((i) => i.undrawn)), view.currency))}</td>
    <td class="num">${esc(money(sum(view.net.investors.map((i) => i.distributed)), view.currency))}</td>
    <td class="num">${esc(money(sum(view.net.investors.map((i) => i.nav)), view.currency))}</td>
    <td class="num">${esc(percent(sum(view.net.investors.map((i) => i.ownership))))}</td>
    <td></td><td></td>
  </tr></tfoot>
</table>${anyAllocated
  ? '<p class="caveat">Accounts marked <em>Allocated</em> were split pro rata rather than built from booked investor flows. They approximate an equalised account and are not a statement of account.</p>'
  : ''}`;
}

function coverage(view: QuarterView): string {
  const c = view.gross.coverage;
  const unreported = view.gross.positions.filter((p) => p.provenance !== 'reported');

  const rows = unreported.map((p) => `<tr>
    <td>${esc(p.position.name)}</td>
    <td>${esc(p.state.sourcePeriod ? formatPeriod(p.state.sourcePeriod) : 'Never valued')}</td>
    <td class="num">${p.state.lagQuarters}Q</td>
    <td class="num">${esc(money(p.nav, view.currency))}</td>
    <td>${provenanceChip(p.provenance)}</td>
    <td class="note">${esc(p.state.note ?? '')}</td>
  </tr>`).join('');

  return `<div class="kpi-grid">
  <div class="kpi"><p class="kpi-label">Reported</p><p class="kpi-value">${c.reported} / ${c.expected}</p><p class="kpi-note">holdings with a valuation for this quarter</p></div>
  <div class="kpi"><p class="kpi-label">NAV coverage</p><p class="kpi-value">${esc(percent(c.navCoverage, 0))}</p><p class="kpi-note">of value backed by a reported figure</p></div>
  <div class="kpi"><p class="kpi-label">Rolled forward</p><p class="kpi-value">${c.rolledForward}</p><p class="kpi-note">carried at last NAV plus cashflows</p></div>
  <div class="kpi"><p class="kpi-label">Estimated</p><p class="kpi-value">${c.estimated}</p><p class="kpi-note">carried with an assumed value change</p></div>
</div>
${unreported.length === 0
  ? '<p class="caveat">Every holding reported for this quarter.</p>'
  : `<table class="grid compact">
      <thead><tr><th>Holding</th><th>Last valued</th><th class="num">Lag</th><th class="num">NAV carried</th><th>Basis</th><th>Treatment</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`}`;
}

function checks(view: QuarterView): string {
  const rows = view.checks.results.map((r) => `<tr class="check-${r.status}">
    <td>${esc(r.label)}</td>
    <td>${r.status === 'pass' ? '<span class="chip chip-good">Pass</span>' : r.status === 'fail' ? '<span class="chip chip-stop">Fail</span>' : '<span class="chip chip-skip">Skipped</span>'}</td>
    <td class="num">${r.difference === undefined ? '' : esc(r.difference.toFixed(4))}</td>
    <td class="note">${esc(r.detail)}</td>
  </tr>`).join('');

  return `<table class="grid compact">
  <thead><tr><th>Identity</th><th>Result</th><th class="num">Difference</th><th>What it asserts</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p class="caveat">A passing check does not prove a figure is right; a failing one proves it is wrong.
Checks marked skipped had no inputs to test — a check that silently never ran would be worse than one that failed.</p>`;
}

function conventions(view: QuarterView): string {
  const c = view.conventions;
  const vehicle = view.vehicles[0];
  const items: Array<[string, string]> = [
    ['Reporting currency', `${view.currency}. Balances translate at the period closing rate; cashflows at ${c.flowRate === 'average' ? 'the period average rate' : 'the rate of their own date'}.`],
    ['Internal rate of return', `Money-weighted on ${c.irrBasis === 'daily' ? 'daily-dated' : 'period-end'} cashflows, with the closing net asset value as a terminal inflow.`],
    ['Commitments', c.recallableRestoresCommitment
      ? 'Open commitment includes recallable distributions, which restore undrawn commitment.'
      : 'Open commitment excludes recallable distributions.'],
    ['Incomplete quarters', `A holding with no valuation for the period is carried at its last reported net asset value adjusted for cashflows since${c.draftPolicy.valueChange === 'portfolio' ? ', and marked with the value change achieved by the holdings that did report' : c.draftPolicy.valueChange === 'fixed' ? `, and marked with an assumed ${percent(c.draftPolicy.fixedReturn ?? 0)} value change` : ''}. A quarter with less than ${percent(c.draftPolicy.minimumCoverage, 0)} of net asset value reported is not issued.`],
    ['Gross and net', 'Gross figures measure the underlying portfolio before anything the vehicle charges. Net figures are after management fees, expenses and accruals. The two tiers do not reconcile to each other.'],
    ['Administrator', vehicle?.administrator ?? 'Not stated'],
  ];

  return `<dl class="conventions">${items.map(([term, detail]) =>
    `<dt>${esc(term)}</dt><dd>${esc(detail)}</dd>`).join('')}</dl>`;
}

/* ------------------------------------------------------------------ helpers */

function dimensionLabel(dimension: string): string {
  const labels: Record<string, string> = {
    assetClass: 'Asset class',
    subAssetClass: 'Sub-asset class',
    region: 'Region',
    sector: 'Sector',
    country: 'Country',
    currency: 'Currency',
    vintage: 'Vintage year',
    manager: 'Manager',
    positionKind: 'Position type',
  };
  return labels[dimension] ?? dimension;
}

function provenanceChip(provenance: string): string {
  const tone = provenance === 'reported' ? 'good'
    : provenance === 'missing' ? 'stop'
    : provenance === 'estimated' ? 'serious' : 'warning';
  return `<span class="chip chip-${tone}">${esc(PROVENANCE_LABEL[provenance as keyof typeof PROVENANCE_LABEL] ?? provenance)}</span>`;
}

function provenanceLine(provenance: string): string {
  if (provenance === 'reported') return '';
  return `<p class="caveat">Weakest input across these figures: ${esc(PROVENANCE_LABEL[provenance as keyof typeof PROVENANCE_LABEL] ?? provenance)}.</p>`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = `
:root{color-scheme:light;--surface:#fcfcfb;--surface-2:#f0efec;--border:#e2e1dc;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#7a7973;
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4;--series-6:#008300;--series-7:#4a3aa7;--series-8:#e34948;
--up:#2a78d6;--down:#d03b3b;--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--stop:#d03b3b;--grid:#e9e8e4}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--surface:#1a1a19;--surface-2:#242422;--border:#34342f;--ink:#fff;--ink-2:#c3c2b7;--ink-3:#8f8e85;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#008300;--series-7:#9085e9;--series-8:#e66767;--up:#3987e5;--grid:#2c2c29}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:960px;margin:0 auto;padding:32px 24px 64px}
.num,.tabular{font-variant-numeric:tabular-nums}
h1{font-size:1.75rem;margin:.2em 0 .1em;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:0 0 .35em;letter-spacing:-.005em}
h3{font-size:.9rem;margin:1.5em 0 .5em;color:var(--ink-2)}
p{margin:.5em 0}
.cover{border-bottom:2px solid var(--border);padding-bottom:20px;margin-bottom:28px}
.eyebrow{margin:0;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.lede{color:var(--ink-2);margin:.25em 0 .75em}
.asat{color:var(--ink-2);font-size:.8125rem}
.block{margin:32px 0;padding-top:20px;border-top:1px solid var(--border)}
.cover + .block{border-top:none;padding-top:0}
.intro{color:var(--ink-2);font-size:.8125rem;max-width:62ch}
.summary{font-size:.95rem;max-width:70ch}
.quals{margin:.75em 0 0;padding-left:1.1em;color:var(--ink-3);font-size:.8125rem}
.flag{display:inline-block;padding:2px 9px;border-radius:4px;font-size:.75rem;font-weight:600;background:var(--surface-2)}
.flag-good{color:var(--good)}.flag-draft{color:var(--serious)}.flag-stop{color:var(--stop)}
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}
@media (max-width:640px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--surface-2);border-radius:6px;padding:10px 12px}
.kpi-label{margin:0;font-size:.6875rem;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)}
.kpi-value{margin:4px 0 2px;font-size:1.2rem;font-weight:600;font-variant-numeric:tabular-nums}
.kpi-note{margin:0;font-size:.6875rem;color:var(--ink-3)}
.grid{width:100%;border-collapse:collapse;font-size:.8125rem;margin:12px 0;font-variant-numeric:tabular-nums}
.grid.compact{font-size:.75rem}
.grid th{text-align:left;font-weight:600;color:var(--ink-2);padding:6px 8px;border-bottom:1px solid var(--border)}
.grid td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
.grid tfoot td{font-weight:600;border-top:2px solid var(--ink-3);border-bottom:none}
.grid .num,.grid th.num{text-align:right}
.grid .note{color:var(--ink-3);font-size:.6875rem}
.grid .sub{display:block;font-size:.6875rem;color:var(--ink-3)}
.grid tr.anchor td{font-weight:600}
.chart{margin:8px 0 4px}
.chart svg{width:100%;height:auto;display:block;overflow:visible}
.chart figcaption{font-size:.6875rem;color:var(--ink-3);margin-top:2px}
.grid-line{stroke:var(--grid);stroke-width:1}
.axis-line{stroke:var(--ink-3);stroke-width:1}
.axis{font-size:10px;fill:var(--ink-3)}
.bar-value{font-size:10px;font-weight:600;fill:var(--ink);font-variant-numeric:tabular-nums}
.bar-anchor{fill:var(--ink-2)}.bar-up{fill:var(--up)}.bar-down{fill:var(--down)}
.connector{stroke:var(--ink-3);stroke-width:1;stroke-dasharray:3 3;opacity:.6}
.bars{list-style:none;margin:10px 0;padding:0;display:flex;flex-direction:column;gap:7px}
.bar-row{display:flex;align-items:baseline;gap:8px;margin-bottom:3px}
.swatch{width:9px;height:9px;border-radius:2px;flex:none}
.bar-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8125rem}
.bar-figures{font-size:.75rem;color:var(--ink-2);flex:none}
.bar-track{height:8px;background:var(--surface-2);border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px}
.drivers{list-style:none;margin:.4em 0;padding:0;font-size:.8125rem}
.drivers li{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid var(--border)}
.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:20px}
.chip{display:inline-block;padding:1px 7px;border-radius:3px;font-size:.6875rem;font-weight:600;background:var(--surface-2)}
.chip-good{color:var(--good)}.chip-warning{color:var(--warning)}.chip-serious{color:var(--serious)}
.chip-stop{color:var(--stop)}.chip-skip{color:var(--ink-3)}
.caveat{font-size:.75rem;color:var(--ink-3);max-width:70ch}
.stop{font-size:.8125rem;color:var(--stop);font-weight:600}
.conventions{margin:8px 0;font-size:.8125rem}
.conventions dt{font-weight:600;margin-top:10px}
.conventions dd{margin:2px 0 0;color:var(--ink-2);max-width:74ch}
.foot{margin-top:44px;padding-top:14px;border-top:1px solid var(--border);font-size:.6875rem;color:var(--ink-3)}
.foot p{margin:2px 0}
@media print{.page{max-width:none;padding:0}.block{break-inside:avoid}.chart{break-inside:avoid}}
`;
