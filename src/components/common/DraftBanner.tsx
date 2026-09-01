import { AlertTriangle, CheckCircle2, XOctagon } from 'lucide-react';
import type { QuarterView } from '../../engine';
import { percent } from './format';

/**
 * The banner that stops a draft being mistaken for a final report.
 *
 * It states three things: whether the quarter is publishable at all, how much of
 * the portfolio actually reported, and every qualification behind the figures.
 * A reader who takes only the headline still cannot take it as final.
 */
export function DraftBanner({ view }: { view: QuarterView }) {
  const { coverage } = view.gross;

  if (view.isFinal) {
    return (
      <Banner
        tone="var(--status-good)"
        icon={<CheckCircle2 size={16} aria-hidden />}
        title="Final"
        body={`Every position reported for this quarter and all ${view.checks.passed} identity checks passed.`}
      />
    );
  }

  if (!coverage.publishable) {
    return (
      <Banner
        tone="var(--status-critical)"
        icon={<XOctagon size={16} aria-hidden />}
        title="Below the coverage floor — not publishable"
        body={`Only ${percent(coverage.navCoverage, 0)} of net asset value is backed by a valuation reported for this quarter. The figures below are shown for review only and must not be issued.`}
        items={view.qualifications}
      />
    );
  }

  return (
    <Banner
      tone="var(--status-serious)"
      icon={<AlertTriangle size={16} aria-hidden />}
      title="Draft calculation"
      body={`${coverage.reported} of ${coverage.expected} positions have reported, covering ${percent(coverage.navCoverage, 0)} of net asset value. The remainder is rolled forward or estimated, and every affected figure is badged.`}
      items={view.qualifications}
    />
  );
}

function Banner({
  tone, icon, title, body, items,
}: {
  tone: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  items?: string[];
}) {
  return (
    <div
      className="card flex gap-3 p-3.5"
      style={{ borderLeftWidth: 3, borderLeftColor: tone }}
      role="status"
    >
      <span className="mt-0.5 shrink-0" style={{ color: tone }}>{icon}</span>
      <div className="min-w-0">
        <p className="m-0 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
        <p className="mt-1 mb-0 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{body}</p>
        {items && items.length > 0 && (
          <ul className="mt-2 mb-0 list-disc space-y-0.5 pl-4 text-xs" style={{ color: 'var(--text-muted)' }}>
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
