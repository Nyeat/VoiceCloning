import React from 'react';
import Spinner from './Spinner.jsx';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';

/**
 * The one voice the kiosk will speak in, chosen from a single dropdown.
 *
 * Two kinds of voice share that dropdown, grouped rather than merged: the
 * voices the signed-in lecturer owns (resolved by the server from their email —
 * a lecturer never sees anyone else's), and the standard voices, stock
 * ElevenLabs voices offered to everyone alike, which belong to nobody, need no
 * training and speak without touching the GPU.
 *
 * An admin can switch the list to every voice, which the server allows only for
 * the Supervisor role. That switch lives at the foot of the menu, where it
 * reads as what it is, instead of as a chip beside the heading.
 *
 * Presentational: it renders what it is given and reports the pick. Fetching and
 * selection live with the page that owns the voice state.
 */

// Menu values are prefixed because a lecturer's voice ids and the stock ones
// come from different systems and are only unique within their own group.
const OWN = 'mine';
const STANDARD = 'std';
const SCOPE_TOGGLE = '__scope__';

function itemValue(kind, voice) {
  return `${kind}:${voice.voiceProfileId}`;
}

function describeStandardVoice(voice) {
  return [voice.gender, voice.accent].filter(Boolean).join(' · ');
}

function describeOwnVoice(voice, showingAll) {
  if (showingAll) return voice.ownerEmail || 'no owner recorded';
  // Trained, but nobody has picked a reference clip or synthesis settings for
  // it yet in the TTS page.
  return voice.hasSavedProfile === false ? 'no saved settings yet' : '';
}

function VoiceItem({ kind, voice, subtitle }) {
  return (
    <SelectItem value={itemValue(kind, voice)} className="py-1.5 text-xs">
      <span className="truncate">
        {voice.label || voice.displayName}
        {voice.label ? <span className="text-slate-400"> · {voice.displayName}</span> : null}
        {subtitle ? <span className="text-slate-400"> · {subtitle}</span> : null}
      </span>
    </SelectItem>
  );
}

export default function MyVoicesPanel({
  voices = [],
  standardVoices = [],
  isAdmin = false,
  scope = 'mine',
  loading = false,
  error = '',
  selectedVoiceName = '',
  selectedVoiceProfileId = '',
  disabled = false,
  trainingUrl = '',
  onSelectVoice = () => {},
  onScopeChange = () => {},
  onRetry = () => {},
}) {
  const showingAll = scope === 'all';

  // A stock voice wins the match: the page blanks the display name whenever one
  // is in use, and a stock name is not unique against a lecturer's own names.
  const selectedStandard = selectedVoiceProfileId
    ? standardVoices.find((voice) => voice.voiceProfileId === selectedVoiceProfileId)
    : null;
  const selectedOwn = selectedStandard
    ? null
    : voices.find((voice) => voice.displayName === selectedVoiceName);

  const value = selectedStandard
    ? itemValue(STANDARD, selectedStandard)
    : selectedOwn
      ? itemValue(OWN, selectedOwn)
      : '';

  // A voice can be loaded on the backend without appearing in this list — a
  // colleague's voice pinned by the URL, say. Name it anyway rather than
  // claiming nothing is chosen.
  // Name only: the stock names already read as descriptions ("River - Relaxed,
  // Neutral, Informative"), and appending the accent here would truncate them.
  // The detail belongs in the menu, where there is room to compare.
  const selectedLabel = selectedStandard?.displayName || selectedOwn?.label || selectedOwn?.displayName || selectedVoiceName;

  function handleChange(next) {
    if (next === SCOPE_TOGGLE) {
      onScopeChange(showingAll ? 'mine' : 'all');
      return;
    }
    const separator = next.indexOf(':');
    const kind = next.slice(0, separator);
    const voiceProfileId = next.slice(separator + 1);
    const pool = kind === STANDARD ? standardVoices : voices;
    const voice = pool.find((item) => item.voiceProfileId === voiceProfileId);
    if (voice) onSelectVoice(voice);
  }

  const hasNoVoices = voices.length === 0 && standardVoices.length === 0;

  return (
    <div className="px-4 pt-3">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
          Voice
        </span>
        {loading ? (
          <span className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-400">
            <Spinner size={12} /> Loading voices…
          </span>
        ) : (
          <Select value={value} onValueChange={handleChange} disabled={disabled || hasNoVoices}>
            <SelectTrigger className="h-8 flex-1 rounded-lg border-slate-200 bg-white text-xs">
              <span className="min-w-0 text-left">
                {selectedLabel || (
                  <span className="text-slate-400">
                    {hasNoVoices ? 'No voices available' : 'Choose a voice'}
                  </span>
                )}
              </span>
            </SelectTrigger>
            <SelectContent>
              {voices.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="pl-8 text-[10px] uppercase tracking-widest text-slate-400">
                    {showingAll ? 'All voices' : 'My voices'}
                  </SelectLabel>
                  {voices.map((voice) => (
                    <VoiceItem
                      key={voice.voiceProfileId}
                      kind={OWN}
                      voice={voice}
                      subtitle={describeOwnVoice(voice, showingAll)}
                    />
                  ))}
                </SelectGroup>
              )}
              {standardVoices.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="pl-8 text-[10px] uppercase tracking-widest text-slate-400">
                    Standard voices — no training needed
                  </SelectLabel>
                  {standardVoices.map((voice) => (
                    <VoiceItem
                      key={voice.voiceProfileId}
                      kind={STANDARD}
                      voice={voice}
                      subtitle={describeStandardVoice(voice)}
                    />
                  ))}
                </SelectGroup>
              )}
              {isAdmin && (
                <>
                  <SelectSeparator className="bg-slate-200" />
                  <SelectItem value={SCOPE_TOGGLE} className="py-1.5 text-xs text-slate-500">
                    {showingAll ? 'Show only my voices' : "Show every lecturer's voice"}
                  </SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
        )}
      </div>

      {error ? (
        <p className="mt-2 text-[11px] text-red-600">
          {error}{' '}
          <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
            Retry
          </button>
        </p>
      ) : !loading && !showingAll && voices.length === 0 ? (
        <p className="mt-2 text-[11px] leading-4 text-slate-400">
          No voice of your own yet.{' '}
          {trainingUrl ? (
            <>
              <a
                href={trainingUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-primary underline underline-offset-2"
              >
                Train one
              </a>
              {standardVoices.length > 0 ? ', or pick a standard voice above.' : '.'}
            </>
          ) : (
            standardVoices.length > 0 ? 'Pick a standard voice above.' : ''
          )}
        </p>
      ) : null}
    </div>
  );
}
