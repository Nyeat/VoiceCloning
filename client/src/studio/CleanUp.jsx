// Tools > Clean up (owner 2026-11-24): stale entries on the line (a test set,
// an approved voice nobody will test, an upload that never finished) can be
// withdrawn or deleted for good. Delete removes only the record —
// recordings and trained voices stay in storage. Every action is logged.
import React, { useMemo, useState } from 'react';
import { History, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cancelJob, clearCleanupLog, deleteJob, formatSgt, resetPerson } from './studioApi.js';
import { Button, Card, StatusPill } from './StudioChrome.jsx';

const ACTION_COPY = { deleted: 'Deleted', withdrawn: 'Withdrew', restored: 'Restored', reset: 'Reset for a new voice' };

export function CleanUp({ overview, onAction }) {
  const [filter, setFilter] = useState('stale');
  const [confirm, setConfirm] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const records = overview.records || [];
  const staleCount = records.filter((record) => record.stale).length;
  const shown = useMemo(() => (filter === 'stale' ? records.filter((record) => record.stale) : records), [filter, records]);
  const log = overview.cleanupLog || [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Clean up</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          <b>Withdraw</b> takes that person's voice off the line (sets, training, QC, test slots) and opens their recording page again; recording sessions stay. It cannot be undone.
          {' '}<b>Reset for a new voice</b> (once a run is approved and tested) opens recording for another voice without withdrawing anything.
          {' '}<b>Delete</b> removes just this entry, for good; their recordings and trained voices stay in storage.
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="font-semibold text-slate-900">Entries</h2>
          <div role="tablist" className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
            {[['stale', `Looks stale · ${staleCount}`], ['all', `All · ${records.length}`]].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                className={cn('rounded-md px-3 py-1.5', filter === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">{filter === 'stale' ? 'Nothing looks stale. 🎉' : 'No entries yet.'}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shown.map((record) => (
              <li key={record.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium text-slate-800 [overflow-wrap:anywhere]">
                    {record.ownerName || record.ownerEmail}
                    <span className="font-normal text-slate-500"> · {record.label}</span>
                  </p>
                  <p className="text-xs text-slate-500 [overflow-wrap:anywhere]">
                    {record.ownerEmail} · {record.files} file{record.files === 1 ? '' : 's'}
                    {record.lastAt && ` · last activity ${formatSgt(record.lastAt)}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <StatusPill status={record.status} />
                  {record.stale && <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">{record.stale}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {record.reset && <span className="text-xs text-slate-500">Reset · can record a new voice</span>}
                  {record.canReset && (
                    <Button size="sm" variant="outline" onClick={() => onAction(() => resetPerson(record.id))} title="Their run is finished: open recording for another voice (nothing is withdrawn)"><RefreshCw size={14} /> Reset for a new voice</Button>
                  )}
                  {!['cancelled', 'training'].includes(record.status) && (
                    <Button size="sm" variant="outline" onClick={() => onAction(() => cancelJob(record.id))}><RotateCcw size={14} /> Withdraw</Button>
                  )}
                  {record.status !== 'training' && (confirm === record.id ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => onAction(() => deleteJob(record.id)).then(() => setConfirm(''))}>Delete for good</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm('')}>Keep</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(record.id)} aria-label={`Delete ${record.ownerName || record.ownerEmail}`}><Trash2 size={14} /> Delete</Button>
                  ))}
                  {record.status === 'training' && <span className="text-xs text-slate-500">On the GPU now</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900"><History size={16} /> Log</h2>
          {log.length > 0 && (confirmClear ? (
            <span className="inline-flex items-center gap-1">
              <Button size="sm" variant="danger" onClick={() => onAction(() => clearCleanupLog()).then(() => setConfirmClear(false))}>Clear the whole log?</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>Keep</Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)}><Trash2 size={14} /> Clear log</Button>
          ))}
        </div>
        {log.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">Nothing withdrawn or deleted yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {log.map((entry) => (
              <li key={`${entry.at}-${entry.jobId}-${entry.action}`} className="flex flex-wrap gap-x-3 px-4 py-2.5 sm:px-5">
                <span className="w-44 shrink-0 text-xs leading-5 text-slate-500">{formatSgt(entry.at)}</span>
                <span className="min-w-0 flex-1 text-slate-700 [overflow-wrap:anywhere]">
                  <b className={entry.action === 'deleted' ? 'text-rose-700' : 'text-slate-900'}>{ACTION_COPY[entry.action] || entry.action}</b>
                  {' '}{entry.who}{entry.label ? ` · ${entry.label}` : ''} <span className="text-slate-500">(was {entry.status}{entry.note ? `; ${entry.note}` : ''})</span>
                  <span className="block text-xs text-slate-500">by {entry.actor}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
