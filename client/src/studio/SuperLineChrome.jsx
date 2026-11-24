// Super-user console chrome for the "train line": the sidebar (stops in order),
// the phone strip, and the header each stop's page opens with.
import React, { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Headphones, LogOut, Map, ShieldCheck, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STOPS, STOP_COPY, stopForPath } from './superLine.js';
import { Brand } from './StudioChrome.jsx';

/** A numbered station: filled = you act, ring = lecturer acts, dashed = runs by itself. */
export function StationDot({ stop, active = false, dark = false, size = 'md', className }) {
  const sizes = { sm: 'h-6 w-6 text-xs', md: 'h-7 w-7 text-xs', lg: 'h-12 w-12 text-lg' };
  const line = dark ? 'border-[#6b8cff] text-[#6b8cff]' : 'border-primary text-primary';
  const fill = dark ? 'bg-[#6b8cff] text-slate-950' : 'bg-primary text-white';
  const hollow = dark ? 'bg-slate-950' : 'bg-white';
  let look;
  if (active) look = dark ? 'bg-white text-slate-950 ring-4 ring-[#6b8cff]/45' : 'bg-primary text-white ring-4 ring-primary/20';
  else if (stop.kind === 'you') look = fill;
  else look = cn(hollow, line, stop.kind === 'auto' ? 'border-[2.5px] border-dashed' : 'border-[2.5px]', size === 'lg' && 'border-[5px]');
  return (
    <span className={cn('relative z-10 flex shrink-0 items-center justify-center rounded-full font-mono font-semibold', sizes[size], look, className)} aria-hidden="true">
      {stop.n}
    </span>
  );
}

function StopLink({ stop, info, active }) {
  return (
    <NavLink
      to={stop.path}
      aria-current={active ? 'page' : undefined}
      className={cn('relative flex min-h-[52px] items-center gap-3 rounded-xl px-2.5 py-2 transition-colors', active ? 'bg-white/[0.12] shadow-[inset_3px_0_0_#8ea6ff]' : 'hover:bg-white/[0.06]')}
    >
      <StationDot stop={stop} active={active} dark size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('text-sm leading-tight', active ? 'font-bold text-white' : 'font-medium text-slate-200')}>{stop.label}</span>
        <span className={cn('text-[11px]', stop.kind === 'you' ? 'text-[#a9bbff]' : 'text-slate-400')}>{stop.who}</span>
      </span>
      {/* A bare count keeps the stop names readable in 240px; the full wording is the tooltip. */}
      {info?.badge && (
        <span title={info.badge} className={cn('min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px]', info.alerts ? 'bg-amber-400 font-bold text-stone-900' : 'bg-white/10 font-semibold text-slate-200')}>
          {info.alerts || info.count}
          <span className="sr-only"> · {info.badge}</span>
        </span>
      )}
    </NavLink>
  );
}

const toolLink = ({ isActive }) => cn('flex min-h-11 items-center gap-3 rounded-xl px-2.5 text-sm transition-colors', isActive ? 'bg-white/[0.12] font-semibold text-white shadow-[inset_3px_0_0_#8ea6ff]' : 'text-slate-300 hover:bg-white/[0.06] hover:text-white');
const sectionLabel = 'mx-2.5 mb-1.5 mt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500';

/** Desktop sidebar: home, the six stops on a vertical line, then tools and admin. */
export function SuperSidebar({ line, email, onSignOut }) {
  const { pathname } = useLocation();
  const current = stopForPath(pathname);
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-white/5 bg-gradient-to-b from-slate-950 to-[#0b1224] px-3 py-5 text-white lg:flex">
      <div className="flex items-center justify-between gap-2 px-2">
        <Brand product="Voice Studio" tone="dark" />
      </div>
      <span className="mx-2 mt-3 inline-flex w-fit items-center gap-1 rounded-full bg-amber-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300 ring-1 ring-amber-300/20"><ShieldCheck size={12} /> Super user</span>
      <nav aria-label="Voice Studio" className="mt-4 flex flex-col gap-1">
        <NavLink to="/" end className={toolLink}>
          <Map size={17} aria-hidden="true" /> <span className="flex-1">Line map</span>
          {line?.alertTotal > 0 && <span className="rounded-full bg-amber-400 px-2 text-[11px] font-bold text-stone-900">{line.alertTotal} for you</span>}
        </NavLink>
        <p className={sectionLabel}>The line · in order</p>
        <div className="relative flex flex-col gap-0.5">
          <span aria-hidden="true" className="absolute bottom-[26px] left-[21px] top-[26px] w-[3px] rounded bg-[#3b5bdb]" />
          {STOPS.map((stop) => <StopLink key={stop.key} stop={stop} info={line?.stops[stop.key]} active={current === stop.key} />)}
          <div className="relative flex min-h-9 items-center gap-3 px-2.5">
            <span aria-hidden="true" className="flex w-6 justify-center"><span className="h-3.5 w-3.5 rounded-[3px] border-[3px] border-[#3b5bdb] bg-slate-950" /></span>
            <span className="text-xs font-semibold text-slate-400">End of line · voice done</span>
          </div>
        </div>
        <p className={sectionLabel}>Tools · any time</p>
        <NavLink to="/test" className={toolLink}><Headphones size={17} aria-hidden="true" /> Test any voice</NavLink>
        <NavLink to="/superusers" className={toolLink}><Users size={17} aria-hidden="true" /> Super users</NavLink>
      </nav>
      <div className="mt-auto pt-5">
        <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.05] p-2.5 ring-1 ring-white/10">
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#3b5bdb] text-xs font-bold uppercase">{String(email || '?').slice(0, 1)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-slate-100" title={email}>{email}</span>
            <button type="button" onClick={onSignOut} className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"><LogOut size={11} aria-hidden="true" /> Sign out</button>
          </span>
        </div>
      </div>
    </aside>
  );
}

/** Phones and tablets: the line as a swipeable strip under the header. */
export function MobileLine({ line }) {
  const { pathname } = useLocation();
  const current = stopForPath(pathname);
  const navRef = useRef(null);
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);
  const tab = 'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-medium';
  return (
    <nav ref={navRef} aria-label="The line" className="flex items-center gap-1 overflow-x-auto overscroll-x-contain bg-slate-950 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <NavLink to="/" end className={({ isActive }) => cn(tab, isActive ? 'bg-white/15 text-white' : 'text-white/75')}>
        <Map size={14} aria-hidden="true" /> Map
      </NavLink>
      {STOPS.map((stop) => {
        const info = line?.stops[stop.key];
        const active = current === stop.key;
        return (
          <NavLink key={stop.key} to={stop.path} aria-current={active ? 'page' : undefined} className={cn(tab, active ? 'bg-white/15 text-white' : 'text-white/75')}>
            <StationDot stop={stop} active={active} dark size="sm" className="h-5 w-5 text-[10px]" />
            {stop.label}
            {info?.alerts > 0 && <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-stone-900">{info.alerts}</span>}
          </NavLink>
        );
      })}
      <NavLink to="/test" className={({ isActive }) => cn(tab, isActive ? 'bg-white/15 text-white' : 'text-white/75')}>Test any voice</NavLink>
      <NavLink to="/superusers" className={({ isActive }) => cn(tab, isActive ? 'bg-white/15 text-white' : 'text-white/75')}>Super users</NavLink>
    </nav>
  );
}

/** The header every stop's page opens with: where you are, what this stop is for, when it is done, what comes next. */
export function StageHeader({ stopKey }) {
  const index = STOPS.findIndex((stop) => stop.key === stopKey);
  const stop = STOPS[index];
  const copy = STOP_COPY[stopKey];
  if (!stop || !copy) return null;
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto border-b border-slate-200 bg-slate-50">
        <ol className="flex min-w-[760px] items-center px-5 py-3.5">
          {STOPS.map((item, i) => {
            const passed = i < index;
            const here = i === index;
            return (
              <li key={item.key} className={cn('flex min-w-0 items-center gap-2', i < STOPS.length - 1 && 'flex-1')}>
                <NavLink to={item.path} aria-current={here ? 'step' : undefined} className="flex min-h-9 items-center gap-2">
                  <span className={cn(
                    'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold',
                    here ? 'bg-primary text-white ring-4 ring-primary/20' : passed ? 'bg-blue-200 text-blue-900' : 'border-2 border-slate-300 bg-white text-slate-600',
                  )}>{item.n}</span>
                  <span className={cn('whitespace-nowrap text-[13px]', here ? 'font-bold text-slate-900' : passed ? 'font-medium text-slate-700' : 'font-medium text-slate-600')}>{item.label}</span>
                </NavLink>
                {i < STOPS.length - 1 && <span aria-hidden="true" className={cn('mx-1 h-[3px] min-w-4 flex-1 rounded', i < index ? 'bg-primary' : 'bg-slate-200')} />}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="flex flex-wrap gap-6 px-5 py-5 sm:px-6">
        <div className="min-w-0 flex-[999_1_420px]">
          <p className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-600">
            Step {stop.n} of {STOPS.length}
            <span className={cn('rounded-full px-2 py-0.5 text-xs normal-case tracking-normal', stop.kind === 'you' ? 'bg-blue-100 text-blue-900' : 'bg-slate-100 text-slate-600')}>{stop.who}</span>
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px]">{copy.title}</h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-slate-600">{copy.what}</p>
        </div>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5">
            <p className="mb-2 text-xs font-bold text-slate-700">{copy.nothingToDo ? 'Nothing for you here' : 'This stop is done when'}</p>
            <ol className="space-y-1.5">
              {copy.todo.map((text, i) => (
                <li key={text} className="flex gap-2.5 text-[13px] leading-snug text-slate-700">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-900">{i + 1}</span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
