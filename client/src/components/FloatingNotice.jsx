import React from 'react';
import { BellRing, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function FloatingNotice({ notice, onClose }) {
  if (!notice) return null;

  const tone = notice.tone || 'info';
  const isSuccess = tone === 'success';
  const isError = tone === 'error';

  return (
    <div className="pointer-events-none fixed right-5 top-5 z-[90] sm:right-6 sm:top-6">
      <div
        className={cn(
          'pointer-events-auto w-[min(360px,calc(100vw-2rem))] rounded-[22px] border px-4 py-3 shadow-[0_24px_60px_-28px_rgba(15,23,42,0.55)] backdrop-blur-xl transition-all animate-in fade-in slide-in-from-top-3',
          isSuccess && 'border-emerald-200/80 bg-[linear-gradient(135deg,rgba(236,253,245,0.96),rgba(239,246,255,0.95))]',
          isError && 'border-rose-200/80 bg-[linear-gradient(135deg,rgba(255,241,242,0.96),rgba(255,255,255,0.95))]',
          !isSuccess && !isError && 'border-slate-200/80 bg-white/95'
        )}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl',
              isSuccess && 'bg-emerald-100 text-emerald-700',
              isError && 'bg-rose-100 text-rose-700',
              !isSuccess && !isError && 'bg-slate-100 text-slate-600'
            )}
          >
            {isSuccess ? <Check size={18} /> : isError ? <X size={18} /> : <BellRing size={18} />}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">{notice.title}</p>
            {notice.message && (
              <p className="mt-1 text-sm leading-6 text-slate-600">{notice.message}</p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// A FloatingNotice the person can close; it stays closed for that notice's
// `key` and shows again only for a new one.
export function DismissibleNotice({ notice }) {
  const [dismissedKey, setDismissedKey] = React.useState('');
  const visible = notice && notice.key !== dismissedKey ? notice : null;
  return <FloatingNotice notice={visible} onClose={() => setDismissedKey(notice?.key || '')} />;
}
