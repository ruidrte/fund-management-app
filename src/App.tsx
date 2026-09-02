import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ScopeProvider, useScope } from './context/ScopeContext';
import { DataSourceProvider } from './context/DataSourceContext';
import { SignIn } from './components/auth/SignIn';
import { Header } from './components/layout/Header';
import { ScopeBar } from './components/layout/ScopeBar';
import { Navigation, type PageId } from './components/layout/Navigation';
import { Dashboard } from './pages/Dashboard';
import { Portfolio } from './pages/Portfolio';
import { Exposure } from './pages/Exposure';
import { Investors } from './pages/Investors';
import { Reports } from './pages/Reports';
import { DataQuality } from './pages/DataQuality';
import { Esg } from './pages/Esg';
import { Intake } from './pages/Intake';
import { Export } from './pages/Export';
import { Access } from './pages/Access';
import { Storage } from './pages/Storage';
import { Close } from './pages/Close';

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ThemeProvider>
  );
}

/**
 * With a backend configured, a session is required before any client data is
 * requested. Row level security would return zero rows to an unauthenticated
 * client rather than an error, which on screen is indistinguishable from an
 * empty portfolio — so the gate is what makes a failed sign-in visible.
 */
function Gate() {
  const { loading, user, requiresAuth } = useAuth();

  if (requiresAuth && loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Checking your session…</p>
      </div>
    );
  }

  if (requiresAuth && !user) return <SignIn />;

  return (
    <DataSourceProvider>
      <ScopeProvider>
        <Shell />
      </ScopeProvider>
    </DataSourceProvider>
  );
}

/** Screens that work with no data at all — and must, or an empty book traps you. */
const WITHOUT_DATA: PageId[] = ['storage', 'access'];

function Shell() {
  const [page, setPage] = useState<PageId>('dashboard');
  const { loading, error, view, clientId } = useScope();
  const standalone = WITHOUT_DATA.includes(page);

  return (
    <div className="flex h-full flex-col">
      <Header />
      <ScopeBar />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Navigation active={page} onChange={setPage} clientId={clientId} />
        <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
          {error && <Notice tone="var(--status-critical)" title="Could not load this scope" body={error} />}
          {!error && loading && !standalone && (
            <Notice tone="var(--text-muted)" title="Loading" body="Reading the client's data." />
          )}
          {!error && !loading && !view && !standalone && (
            <Notice
              tone="var(--status-warning)"
              title="Nothing to analyse"
              body="No client with data is loaded. Storage shows where the data is and how to connect a folder."
            />
          )}
          {(standalone || (!error && view)) && <Page page={page} />}
        </main>
      </div>
    </div>
  );
}

function Page({ page }: { page: PageId }) {
  const { view } = useScope();
  if (page === 'storage') return <Storage />;
  if (page === 'access') return <Access />;
  if (!view) return null;

  switch (page) {
    case 'portfolio': return <Portfolio view={view} />;
    case 'exposure': return <Exposure view={view} />;
    case 'investors': return <Investors view={view} />;
    case 'reports': return <Reports view={view} />;
    case 'quality': return <DataQuality view={view} />;
    case 'intake': return <Intake view={view} />;
    case 'export': return <Export view={view} />;
    case 'esg': return <Esg view={view} />;
    case 'close': return <Close />;
    case 'dashboard':
    default: return <Dashboard view={view} />;
  }
}

function Notice({ tone, title, body }: { tone: string; title: string; body: string }) {
  return (
    <div className="card flex gap-3 p-4" style={{ borderLeftWidth: 3, borderLeftColor: tone }} role="status">
      <AlertCircle size={16} className="mt-0.5 shrink-0" style={{ color: tone }} aria-hidden />
      <div>
        <p className="m-0 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
        <p className="mt-1 mb-0 text-xs" style={{ color: 'var(--text-secondary)' }}>{body}</p>
      </div>
    </div>
  );
}
