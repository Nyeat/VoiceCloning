// Super-user home: the line map. Who is at which stop, the one thing to do
// next, and every lecturer with their position on the line. First visit shows
// a short welcome that explains the six stops.
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STOPS } from './superLine.js';
import { formatSgt } from './studioApi.js';
import { StationDot } from './SuperLineChrome.jsx';

const STOP_BY_KEY = Object.fromEntries(STOPS.map((stop) => [stop.key, stop]));
const WELCOME_KEY = 'voice-studio-line-welcome-seen';
const MAX_CHIPS = 3;

/** A rider's short status, with its time when there is one. */
export function riderNote(rider) {
  if (!rider.at) return rider.note;
  // Stop 1 rows are a session date: "Wed 25 Nov, 2:00 pm" or "… · draft".
  if (rider.stop === 'book') return rider.alert ? `${formatSgt(rider.at)} · draft` : formatSgt(rider.at);
  if (rider.note === 'Test slot') return `${rider.note} ${formatSgt(rider.at)}`;
  return `${rider.note} ${formatSgt(rider.at, { withDate: false })}`;
}

function initials(name) {
  return String(name || '?').replace(/^(Dr|Prof|A\/Prof|Assoc Prof)\.?\s+/iu, '').split(/[\s@.]+/u).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join('');
}

function PersonChip({ rider }) {
  return (
    <Link to={rider.href} className={cn('flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5', rider.alert ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-slate-50 hover:bg-white')}>
      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold', rider.alert ? 'bg-amber-500 text-stone-900' : 'bg-slate-200 text-slate-700')}>{initials(rider.name)}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-semibold text-slate-900" title={rider.email}>{rider.name}</span>
        <span className={cn('truncate text-[11px]', rider.alert ? 'font-semibold text-amber-800' : 'text-slate-600')}>{riderNote(rider)}</span>
      </span>
    </Link>
  );
}

function LineMapCard({ line }) {
  return (
    <section aria-labelledby="map-h" className="rounded-2xl border border-slate-200 bg-white px-4 pb-5 pt-4 shadow-sm sm:px-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 id="map-h" className="text-base font-bold text-slate-900">Who is where</h2>
        <ul className="flex flex-wrap gap-4 text-xs text-slate-600">
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3.5 w-3.5 rounded-full bg-primary" /> You act</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border-[3px] border-primary" /> Lecturer acts</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border-[3px] border-dashed border-primary" /> Runs by itself</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Waiting on you</li>
        </ul>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="relative min-w-[900px] pt-4">
          <span aria-hidden="true" className="absolute left-[calc((100%-72px)/12)] right-9 top-[37px] h-1.5 rounded-full bg-primary" />
          <div className="grid grid-cols-[repeat(6,minmax(0,1fr))_72px] items-start">
            {STOPS.map((stop) => {
              const info = line.stops[stop.key];
              const shown = info.people.slice(0, MAX_CHIPS);
              return (
                <div key={stop.key} className="flex flex-col items-center gap-2.5 px-1.5">
                  <Link to={stop.path} aria-label={`Step ${stop.n}: ${stop.label}`} className="relative rounded-full ring-[5px] ring-white">
                    <StationDot stop={stop} size="lg" />
                    {info.alerts > 0 && (
                      <span className="absolute -right-2 -top-1.5 z-20 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-amber-500 px-1 text-[11px] font-bold text-stone-900">{info.alerts}</span>
                    )}
                  </Link>
                  <div className="text-center">
                    <p className="text-sm font-bold text-slate-900">{stop.label}</p>
                    <p className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold', stop.kind === 'you' ? 'bg-blue-100 text-blue-900' : 'bg-slate-100 text-slate-600')}>{stop.who}</p>
                  </div>
                  <div className="flex w-full flex-col gap-1.5">
                    {shown.map((rider) => <PersonChip key={rider.email} rider={rider} />)}
                    {info.people.length > MAX_CHIPS && (
                      <Link to={stop.path} className="text-center text-xs font-semibold text-primary hover:underline">+{info.people.length - MAX_CHIPS} more</Link>
                    )}
                    {info.people.length === 0 && <p className="text-center text-xs text-slate-500">Nobody</p>}
                  </div>
                </div>
              );
            })}
            <div className="flex flex-col items-center gap-2.5">
              <span aria-hidden="true" className="mt-2.5 h-6 w-6 rounded-md border-[5px] border-primary bg-white" />
              <p className="text-center text-xs font-bold text-slate-700">Voice done</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function NextBar({ next }) {
  if (!next) {
    return <p className="rounded-2xl bg-emerald-50 px-5 py-4 text-sm font-semibold text-emerald-900 ring-1 ring-emerald-200">Nothing is waiting on you right now.</p>;
  }
  const stop = STOP_BY_KEY[next.key];
  const unit = next.key === 'book' ? 'session' : next.key === 'record' ? 'recording' : next.key === 'assign' ? 'lecturer' : 'voice';
  return (
    <section aria-labelledby="next-h" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl bg-[#0f1b3d] py-3.5 pl-5 pr-4 text-white">
      <StationDot stop={stop} dark className="h-8 w-8 text-sm" />
      <h2 id="next-h" className="min-w-0 flex-[1_1_240px] text-[17px] font-bold">
        Next: {stop.label.toLowerCase()} <span className="font-medium text-slate-300">· {next.count} {unit}{next.count === 1 ? '' : 's'}</span>
      </h2>
      <Link to={stop.path} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-white px-4 text-sm font-bold text-[#0f1b3d] hover:bg-slate-100">
        Start <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </section>
  );
}

function MiniTrack({ stopKey, alert }) {
  const at = STOPS.findIndex((stop) => stop.key === stopKey);
  return (
    <div className="flex items-center" aria-label={`Stop ${at + 1} of ${STOPS.length}`} role="img">
      {STOPS.map((stop, i) => (
        <React.Fragment key={stop.key}>
          <span className={cn(
            'shrink-0 rounded-full',
            i === at ? cn('h-3.5 w-3.5', alert ? 'bg-amber-500 ring-4 ring-amber-500/25' : 'bg-primary ring-4 ring-primary/20') : cn('h-2.5 w-2.5', i < at ? 'bg-primary' : 'bg-slate-300'),
          )} />
          {i < STOPS.length - 1 && <span className={cn('h-[3px] w-[18px]', i < at ? 'bg-primary' : 'bg-slate-200')} />}
        </React.Fragment>
      ))}
    </div>
  );
}

const CTA = { book: 'Publish', record: 'Upload audio', qc: 'Review voice', assign: 'Assign a slot' };

function RidersTable({ riders }) {
  return (
    <section aria-labelledby="riders-h" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-4">
        <h2 id="riders-h" className="text-base font-bold text-slate-900">Every lecturer on the line</h2>
        <p className="text-xs text-slate-600">The ones waiting on you come first</p>
      </div>
      {riders.length === 0 ? <p className="px-5 py-6 text-sm text-slate-600">Nobody is on the line yet. Start by booking a recording session.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm md:min-w-[720px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-slate-600">
                <th scope="col" className="px-4 py-2.5 font-semibold sm:px-5">Lecturer</th>
                <th scope="col" className="hidden px-3 py-2.5 font-semibold md:table-cell">Position</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Where they are</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold sm:px-5">Next</th>
              </tr>
            </thead>
            <tbody>
              {riders.map((rider) => (
                <tr key={rider.email} className="border-t border-slate-100">
                  <td className="px-4 py-3 sm:px-5"><span className="font-semibold text-slate-900">{rider.name}</span><br /><span className="break-all text-xs text-slate-600">{rider.email}</span></td>
                  <td className="hidden px-3 py-3 md:table-cell"><MiniTrack stopKey={rider.stop} alert={rider.alert} /></td>
                  <td className="px-3 py-3"><span className="font-medium text-slate-900">{STOP_BY_KEY[rider.stop].label}</span><br /><span className="text-xs text-slate-600">{riderNote(rider)}</span></td>
                  <td className="px-4 py-3 text-right sm:px-5">
                    {rider.alert
                      ? <Link to={rider.href} className="inline-flex min-h-9 items-center whitespace-nowrap rounded-lg bg-primary px-3 text-[13px] font-semibold text-white hover:bg-primary/90">{CTA[rider.stop] || 'Open'}</Link>
                      : <Link to={rider.href} className="inline-flex min-h-9 items-center whitespace-nowrap px-1 text-[13px] font-medium text-slate-600 hover:text-slate-900">{rider.done ? 'Read feedback' : 'View'}</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const WELCOME_STOPS = {
  book: 'Agree a time in person, add it to the calendar, press Publish. The lecturer is emailed.',
  record: 'The lecturer records in the session. You upload the audio files, which sends them to training.',
  train: 'The GPU trains the voice. You are emailed when it finishes.',
  qc: 'Check the voice before the lecturer hears it: approve, or retrain.',
  assign: 'Assign them 20 minutes on their own GPU and publish. They are emailed.',
  test: 'They try their voice and send feedback, which closes the loop.',
};

function WelcomeDialog({ onClose }) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const yours = STOPS.filter((stop) => stop.kind === 'you').length;
  return (
    <div className="vs-root fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 px-4 py-8 sm:py-12" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="welcome-h" className="w-full max-w-[760px] overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="px-6 pb-2 pt-7 sm:px-8">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-primary">Welcome to Voice Studio</p>
          <h2 id="welcome-h" className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px]">Every voice rides one line, in six stops</h2>
          <p className="mt-2.5 text-[15px] leading-relaxed text-slate-600">The sidebar is this same line, in the same order. You act at the <b className="text-slate-900">{yours} filled stops</b>; the lecturer and the GPU handle the rest.</p>
        </div>
        <ol className="px-6 pb-2 pt-4 sm:px-8">
          {STOPS.map((stop) => (
            <li key={stop.key} className="relative flex gap-4 pb-3.5">
              <span aria-hidden="true" className="absolute bottom-[-4px] left-[15px] top-[18px] w-1 bg-primary" />
              <StationDot stop={stop} className="h-9 w-9 text-[15px]" />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold text-slate-900">{stop.label}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', stop.kind === 'you' ? 'bg-blue-100 text-blue-900' : 'bg-slate-100 text-slate-600')}>{stop.who}</span>
                </p>
                <p className="mt-0.5 text-sm leading-normal text-slate-600">{WELCOME_STOPS[stop.key]}</p>
              </div>
            </li>
          ))}
          <li className="flex items-center gap-4">
            <span aria-hidden="true" className="flex w-9 justify-center"><span className="h-5 w-5 rounded-[5px] border-[5px] border-primary" /></span>
            <span className="text-sm font-semibold text-slate-700">End of the line: the voice is ready for teaching tools</span>
          </li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2.5 border-t border-slate-200 bg-slate-50 px-6 py-5 sm:px-8">
          <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Show me the line map</button>
          <button type="button" onClick={() => { onClose(); navigate(STOPS[0].path); }} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-white hover:bg-primary/90">
            Start at stop 1: book a recording <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  );
}

function seenWelcome() {
  try { return window.localStorage.getItem(WELCOME_KEY) === '1'; } catch { return true; }
}
function rememberWelcome() {
  try { window.localStorage.setItem(WELCOME_KEY, '1'); } catch { /* private mode: it shows again next time */ }
}

export function LineMap({ line, now }) {
  const [welcome, setWelcome] = useState(() => !seenWelcome());
  const closeWelcome = () => { rememberWelcome(); setWelcome(false); };
  const today = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(now));
  const heading = line.alertTotal === 0 ? 'Nothing on the line needs you' : `${line.alertTotal} thing${line.alertTotal === 1 ? '' : 's'} on the line need${line.alertTotal === 1 ? 's' : ''} you`;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">{today} · Line map</p>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{heading}</h1>
          <p className="mt-1.5 text-[15px] text-slate-600">You only act at the filled stops.</p>
        </div>
        <button type="button" onClick={() => setWelcome(true)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          <HelpCircle size={16} aria-hidden="true" /> How the line works
        </button>
      </header>
      <LineMapCard line={line} />
      <NextBar next={line.next} />
      <RidersTable riders={line.riders} />
      {welcome && <WelcomeDialog onClose={closeWelcome} />}
    </div>
  );
}
