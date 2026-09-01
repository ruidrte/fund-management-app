/**
 * Storage.
 *
 * Where the data on screen actually is, and what would happen to it if this tab
 * were closed. Every other screen shows figures; this one shows the thing they
 * are read from, because "is this saved?" should never need an engineer.
 */

import { useMemo, useState } from 'react';
import {
  AlertTriangle, Check, FolderOpen, HardDrive, Info, Loader2, RefreshCw, Unplug,
} from 'lucide-react';
import { useDataSource } from '../context/DataSourceContext';
import { useScope } from '../context/ScopeContext';
import { useAuth } from '../context/AuthContext';
import { Card } from '../components/common/Card';
import { StatusPill } from '../components/common/Badges';
import { DataTable } from '../components/common/DataTable';
import { DEMO_CLIENTS } from '../data/demo';

export function Storage() {
  const {
    kind, folderStatus, folderName, folderError, unsupportedReason,
    book, summary, connect, reconnect, disconnect, startBook, rescan,
  } = useDataSource();
  const { clients, clientId } = useScope();
  const { principal } = useAuth();

  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setFailure(undefined);
    try {
      await action();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const problems = book && clientId ? book.problems(clientId) : [];

  // Clients whose structure can still be started here — the ones this folder
  // does not already hold.
  const startable = useMemo(() => {
    const held = new Set(book?.manifest.clients.map((c) => c.id) ?? []);
    return DEMO_CLIENTS.filter((c) => !held.has(c.id));
  }, [book]);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Where this data is"
        subtitle={DESCRIPTION[kind].headline}
        actions={<StatusPill tone={TONE[kind]}>{LABEL[kind]}</StatusPill>}
      >
        <p className="m-0 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {DESCRIPTION[kind].body}
        </p>
      </Card>

      {kind === 'supabase' ? (
        <Card
          title="A folder is not offered alongside a database"
          subtitle="One book of record"
          note="Two places to file the same quarter is how they end up disagreeing, and nothing would tell
                you which one the report came from."
        >
          <p className="m-0 text-xs" style={{ color: 'var(--text-secondary)' }}>
            This build is configured against Supabase, so that is the book. Clear the environment
            variables to run against a folder or the sample data instead.
          </p>
        </Card>
      ) : (
        <Card
          title="A folder on this computer"
          subtitle={folderName ? folderName : 'Real data, no server, no account'}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {folderStatus === 'open' && <StatusPill tone="good">Connected</StatusPill>}
              {folderStatus === 'empty' && <StatusPill tone="warning">No book here yet</StatusPill>}
              {folderStatus === 'needs-permission' && <StatusPill tone="warning">Needs permission</StatusPill>}
              {folderStatus === 'unsupported' && <StatusPill tone="neutral">Not available</StatusPill>}

              {folderStatus === 'needs-permission' && (
                <Action label="Reconnect" busy={busy === 'reconnect'} icon={RefreshCw}
                  onClick={() => run('reconnect', reconnect)} primary />
              )}
              {(folderStatus === 'idle' || folderStatus === 'error') && (
                <Action label="Choose a folder" busy={busy === 'connect'} icon={FolderOpen}
                  onClick={() => run('connect', connect)} primary />
              )}
              {(folderStatus === 'open' || folderStatus === 'empty') && (
                <>
                  <Action label="Refresh" busy={busy === 'rescan'} icon={RefreshCw}
                    onClick={() => run('rescan', rescan)} />
                  <Action label="Use a different folder" busy={busy === 'connect'} icon={FolderOpen}
                    onClick={() => run('connect', connect)} />
                  <Action label="Disconnect" busy={busy === 'disconnect'} icon={Unplug}
                    onClick={() => run('disconnect', disconnect)} />
                </>
              )}
            </div>
          }
          note="The page can only ever reach the one folder you pick, and the browser forgets the
                permission when the tab closes — reopening it asks again. Nothing is uploaded anywhere:
                spreadsheets and PDFs are read here, and what is written goes into that folder and
                nowhere else."
        >
          {folderStatus === 'checking' && (
            <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }}>
              Looking for a folder this browser already knows about…
            </p>
          )}

          {folderStatus === 'unsupported' && (
            <Line tone="var(--status-warning)" icon={AlertTriangle}>
              {unsupportedReason} The sample data still works, and so does export — but a book cannot be
              kept from this browser.
            </Line>
          )}

          {folderStatus === 'needs-permission' && (
            <Line tone="var(--status-warning)" icon={AlertTriangle}>
              <strong>{folderName}</strong> is remembered from last time, but the browser drops the write
              permission when the tab closes. One click restores it; nothing has been read yet.
            </Line>
          )}

          {(folderError || failure) && (
            <Line tone="var(--status-critical)" icon={AlertTriangle}>{folderError ?? failure}</Line>
          )}

          {folderStatus === 'empty' && (
            <div className="mt-1">
              <p className="m-0 mb-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <strong>{folderName}</strong> holds no book. Starting one writes the client and its
                vehicles — the real structure, and not one figure. Everything measured comes from the
                documents you load afterwards.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {startable.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    disabled={busy !== undefined || !principal.isSuperuser}
                    onClick={() => run(`start-${client.id}`, () => startBook(client.id))}
                    className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs disabled:opacity-50"
                    style={{ background: 'var(--series-1)', color: '#fff' }}
                  >
                    {busy === `start-${client.id}`
                      ? <Loader2 size={13} className="animate-spin" aria-hidden />
                      : <HardDrive size={13} aria-hidden />}
                    Start {client.shortName} here
                  </button>
                ))}
              </div>
            </div>
          )}

          {folderStatus === 'open' && book && (
            <div className="flex flex-col gap-3">
              <Line tone="var(--status-good)" icon={Check}>
                Reading and writing <strong>{folderName}</strong>
                {summary?.lastWrite && ` · last written ${new Date(summary.lastWrite).toLocaleString('en-GB')}`}
                {summary && ` · ${summary.files.length} file(s), ${formatBytes(summary.bytes)}`}
              </Line>

              {startable.length > 0 && (
                <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Also available to start here: {startable.map((c) => c.shortName).join(', ')}.{' '}
                  {startable.map((client) => (
                    <button
                      key={client.id}
                      type="button"
                      disabled={busy !== undefined || !principal.isSuperuser}
                      onClick={() => run(`start-${client.id}`, () => startBook(client.id))}
                      className="mr-1.5 rounded px-1.5 py-0.5 text-[11px] disabled:opacity-50"
                      style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
                    >
                      Add {client.shortName}
                    </button>
                  ))}
                </p>
              )}

              {problems.length > 0 && (
                <div>
                  <Line tone="var(--status-warning)" icon={AlertTriangle}>
                    {problems.length} line(s) in this client&rsquo;s files could not be read and were skipped.
                    They are still in the files; nothing was deleted.
                  </Line>
                  <ul className="m-0 mt-1 list-disc pl-5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {problems.slice(0, 8).map((problem) => <li key={problem}>{problem}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {summary && summary.files.length > 0 && (
        <Card
          title="What is in the folder"
          subtitle={`${summary.files.length} file(s), ${formatBytes(summary.bytes)}`}
          note="Plain text throughout, except the source documents themselves. Facts are one JSON object
                per line and are only ever appended — a correction is a new line, which is what lets a
                past quarter still be reproduced as it was published. Reference data — vehicles, holdings,
                investors — is rewritten, because correcting a name should not leave two of them behind."
        >
          <DataTable
            rows={summary.files}
            rowKey={(row) => row.path}
            dense
            columns={[
              { key: 'path', header: 'File', render: (row) => row.path },
              {
                key: 'bytes', header: 'Size', align: 'right',
                render: (row) => formatBytes(row.bytes),
              },
              {
                key: 'modified', header: 'Last written', align: 'right',
                render: (row) => new Date(row.modified).toLocaleString('en-GB'),
              },
            ]}
          />
        </Card>
      )}

      <Card title="What a folder is not" subtitle="So it is chosen knowingly">
        <ul className="m-0 list-disc space-y-1.5 pl-4 text-xs leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}>
          <li>
            <strong>No permissions.</strong> The roles on the Access screen still shape what this
            interface offers, but a folder cannot enforce them — anyone who can open the folder can read
            every file in it. Confidentiality is the folder&rsquo;s, not the application&rsquo;s.
          </li>
          <li>
            <strong>One writer at a time.</strong> Two people with the folder synced and the app open
            will overwrite each other, and a synced drive resolves that by keeping a conflicted copy
            rather than by merging. Fine for one person; not a shared book.
          </li>
          <li>
            <strong>No audit trail beyond the files.</strong> Every fact carries who filed it and when,
            and each document is kept with its hash — but nothing stops the files being edited directly.
          </li>
          <li>
            <strong>Back it up.</strong> A synced drive is a copy, not a backup: a deletion syncs too.
            The export on the Export screen is the portable copy — it reads back in.
          </li>
        </ul>
      </Card>

      {clients.length === 0 && kind !== 'supabase' && (
        <Card title="Nothing to show yet" subtitle="No client is loaded">
          <Line tone="var(--text-muted)" icon={Info}>
            Connect a folder and start a book, or clear the connection to go back to the sample data.
          </Line>
        </Card>
      )}
    </div>
  );
}

const LABEL: Record<string, string> = {
  supabase: 'Supabase',
  folder: 'A folder on this computer',
  sample: 'Sample data',
};

const TONE: Record<string, 'good' | 'warning' | 'neutral'> = {
  supabase: 'good',
  folder: 'good',
  sample: 'warning',
};

const DESCRIPTION: Record<string, { headline: string; body: string }> = {
  supabase: {
    headline: 'A Postgres database, with row-level security',
    body:
      'Every table is read through policies keyed to the signed-in user, so a client’s data is '
      + 'unreachable to anyone without a membership on it. Reading is implemented; writing from the '
      + 'intake screen is not built yet, so documents can be read and reviewed but not filed.',
  },
  folder: {
    headline: 'A folder you chose, on this computer',
    body:
      'Files you can open, copy, back up and hand to somebody else. Nothing is sent anywhere: the '
      + 'spreadsheets and PDFs are parsed in this browser, and what is filed is written into that '
      + 'folder. It is exactly as private as the folder is.',
  },
  sample: {
    headline: 'Nothing is saved',
    body:
      'The structure is real — the clients and vehicles are the ones that exist — and every figure '
      + 'is invented. Anything filed here lasts until the page reloads. Connect a folder below to keep '
      + 'real data instead.',
  },
};

function Action({
  label, icon: Icon, onClick, busy = false, primary = false,
}: {
  label: string;
  icon: typeof FolderOpen;
  onClick: () => void;
  busy?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={busy}
      className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs disabled:opacity-50"
      style={{
        background: primary ? 'var(--series-1)' : 'var(--surface-2)',
        color: primary ? '#fff' : 'var(--text-secondary)',
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Icon size={13} aria-hidden />}
      {label}
    </button>
  );
}

function Line({
  tone, icon: Icon, children,
}: { tone: string; icon: typeof Info; children: React.ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 text-xs leading-relaxed" style={{ color: tone }}>
      <Icon size={13} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
