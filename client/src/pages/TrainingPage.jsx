import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, AudioLines, CheckCircle2, ChevronDown, Clock3, Play, Square, Upload, X } from 'lucide-react';
import FloatingNotice from '../components/FloatingNotice.jsx';
import ProgressTracker from '../components/ProgressTracker.jsx';
import Spinner from '../components/Spinner.jsx';
import {
  allocateTrainingVoiceName,
  getCurrentTraining,
  getMyVoiceProfiles,
  startTraining,
  stopTraining,
  uploadFiles,
} from '../services/api.js';
import { useSSE } from '../hooks/useSSE.js';
import { useAuth } from '@/auth/useAuth';
import { config } from '@/config';
import { validateTrainingStart } from '@/lib/trainingValidation';
import { describeVoiceIdentity } from '@/lib/voiceIdentity';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

const NOTICE_TIMEOUT_MS = 4200;
const BUSY_POLL_MS = 15000;
const SHOW_ADVANCED_SETTINGS = import.meta.env.VITE_SHOW_ADVANCED_SETTINGS !== 'false';
// Must match the Lambda presign allow-list (lambda/upload/index.js).
const ACCEPTED_EXTENSIONS = ['.wav', '.flac', '.mp3', '.m4a', '.ogg'];
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const UPLOAD_TIPS = [
  '10–30 minutes of your own speech in total',
  'Only your voice — no students, music or other speakers',
  'Quiet room, close microphone, no echo',
  'Your normal teaching pace and tone',
];

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatElapsed(startedAt) {
  if (!startedAt) return '';
  const minutes = Math.max(0, Math.round((Date.now() - Number(startedAt)) / 60000));
  if (minutes < 1) return 'started just now';
  if (minutes < 60) return `started ${minutes} min ago`;
  return `started ${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

function hasAcceptedExtension(name = '') {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function Dropzone({ onAdd, disabled }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  function accept(list) {
    if (disabled) return;
    onAdd(Array.from(list || []));
  }
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); } }}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); accept(e.dataTransfer.files); }}
      className={cn(
        'flex min-h-[168px] flex-col items-center justify-center border border-dashed px-6 py-8 text-center transition-colors',
        dragOver ? 'border-primary bg-primary/5' : 'border-slate-300 bg-white hover:border-primary/60',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <Upload size={20} className="text-slate-500" aria-hidden="true" />
      <p className="mt-3 text-sm text-slate-800"><span className="font-semibold">Choose files</span> or drag them here</p>
      <p className="mt-1 text-xs text-slate-500">WAV or FLAC preferred · MP3, M4A, OGG accepted · up to 200 MB each</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="hidden"
        disabled={disabled}
        onChange={(e) => { accept(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}

function SectionHeading({ step, title, hint }) {
  return (
    <div className="mb-3 flex items-baseline gap-3">
      <span className="text-xs font-semibold tabular-nums text-primary">{step}</span>
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
    </div>
  );
}

function SettingSlider({ label, value, suffix = '', min, max, onChange, disabled }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        <span className="font-mono text-xs text-slate-800">{value}{suffix}</span>
      </div>
      <Slider min={min} max={max} step={1} value={[value]} onValueChange={([v]) => onChange(v)} disabled={disabled} />
    </div>
  );
}

export default function TrainingPage({ consent = null }) {
  const auth = useAuth();
  const signedEmail = config.authEnabled ? String(auth?.user?.email || '') : '';
  const [typedEmail, setTypedEmail] = useState('');
  const email = signedEmail || typedEmail;
  const identity = describeVoiceIdentity(email);

  const [files, setFiles] = useState([]);
  const [fileError, setFileError] = useState('');
  const [batchSize, setBatchSize] = useState(2);
  const [sovitsEpochs, setSovitsEpochs] = useState(20);
  const [gptEpochs, setGptEpochs] = useState(25);
  const [sovitsSaveEvery, setSovitsSaveEvery] = useState(4);
  const [gptSaveEvery, setGptSaveEvery] = useState(5);
  const [asrLanguage, setAsrLanguage] = useState('en');
  const [skipDenoise, setSkipDenoise] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [runningExpName, setRunningExpName] = useState('');
  const [startError, setStartError] = useState('');
  const [notice, setNotice] = useState(null);
  const [otherRun, setOtherRun] = useState(null);
  const [voices, setVoices] = useState([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesToken, setVoicesToken] = useState(0);

  const { steps, pipelineStatus, error, connectionLost, connect, disconnect, hydrate, reset } = useSSE();
  const restoredSessionRef = useRef(null);
  const noticeTimeoutRef = useRef(null);
  const previousStatusRef = useRef(null);

  const isRunning = pipelineStatus === 'running' || pipelineStatus === 'waiting';
  const blockedByOther = Boolean(otherRun) && !isRunning;

  const showNotice = useCallback(({ title, message = '', tone = 'success' }) => {
    if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current);
    const id = Date.now();
    setNotice({ id, title, message, tone });
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice((current) => (current?.id === id ? null : current));
    }, NOTICE_TIMEOUT_MS);
  }, []);

  useEffect(() => () => { if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current); }, []);

  // The lecturer's own voices — the server decides ownership from the sign-in.
  useEffect(() => {
    if (!config.authEnabled) return undefined;
    let ignore = false;
    setVoicesLoading(true);
    getMyVoiceProfiles('mine')
      .then((res) => {
        if (ignore) return;
        const list = Array.isArray(res.data?.voices) ? res.data.voices : [];
        setVoices(list.filter((voice) => voice.isMine !== false));
      })
      .catch(() => { if (!ignore) setVoices([]); })
      .finally(() => { if (!ignore) setVoicesLoading(false); });
    return () => { ignore = true; };
  }, [voicesToken]);

  // Who is using the training GPU. The server shows the owner their run in
  // full and everyone else only that the GPU is busy and how far along it is.
  const refreshTrainingState = useCallback(async () => {
    try {
      const res = await getCurrentTraining();
      const current = res.data || {};
      if (current.busy && current.mine === false) {
        setOtherRun(current);
        return;
      }
      setOtherRun(null);
      if (!current.sessionId || current.sessionId === restoredSessionRef.current) return;
      setSessionId(current.sessionId);
      setRunningExpName(current.expName || '');
      const nextState = {
        initialLogs: current.logs || [],
        initialSteps: current.steps || [],
        initialStatus: current.status || 'idle',
        initialError: current.error || null,
      };
      if (current.status === 'running' || current.status === 'waiting') {
        connect(current.sessionId, nextState);
      } else {
        disconnect();
        hydrate(nextState);
      }
      restoredSessionRef.current = current.sessionId;
    } catch {
      // A stopped GPU simply means nobody is training; the badge says why.
      setOtherRun(null);
    } finally {
      if (previousStatusRef.current === null) previousStatusRef.current = 'idle';
    }
  }, [connect, disconnect, hydrate]);

  useEffect(() => {
    refreshTrainingState();
    const id = window.setInterval(() => { if (!isRunning) refreshTrainingState(); }, BUSY_POLL_MS);
    const onReady = () => refreshTrainingState();
    window.addEventListener('voice-cloning-gpu-ready', onReady);
    return () => { window.clearInterval(id); window.removeEventListener('voice-cloning-gpu-ready', onReady); };
  }, [refreshTrainingState, isRunning]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    if (previous === null) return;
    if (pipelineStatus !== previous) {
      if (pipelineStatus === 'complete') {
        showNotice({ title: 'Training complete', message: 'Your new voice is ready to test.', tone: 'success' });
        setVoicesToken((token) => token + 1);
      } else if (pipelineStatus === 'error') {
        showNotice({ title: 'Training needs attention', message: error || 'The run stopped before finishing.', tone: 'error' });
      }
    }
    previousStatusRef.current = pipelineStatus;
  }, [pipelineStatus, error, showNotice]);

  function addFiles(list) {
    const rejected = list.filter((file) => !hasAcceptedExtension(file.name) || file.size > MAX_FILE_BYTES);
    const accepted = list.filter((file) => !rejected.includes(file));
    setFileError(rejected.length
      ? `${rejected.map((file) => file.name).join(', ')} ${rejected.length === 1 ? 'was' : 'were'} skipped (unsupported type or over 200 MB).`
      : '');
    setFiles((current) => [...current, ...accepted]);
  }

  async function handleStart() {
    const validation = validateTrainingStart({
      email, source: 'upload', files, batchSize, sovitsEpochs, gptEpochs, sovitsSaveEvery, gptSaveEvery, asrLanguage,
    });
    if (!validation.valid) {
      const message = validation.errors.join(' ');
      setStartError(message);
      return;
    }
    setStartError('');
    setUploading(true);
    try {
      const allocation = await allocateTrainingVoiceName(validation.email);
      const expName = String(allocation.data?.expName || '').trim();
      if (!expName) throw new Error('The server did not return a name for this voice.');
      setRunningExpName(expName);
      await uploadFiles(expName, files);
      const res = await startTraining({
        expName,
        email: validation.email,
        batchSize,
        sovitsEpochs,
        gptEpochs,
        sovitsSaveEvery,
        gptSaveEvery,
        asrLanguage,
        skipDenoise,
        sourceDatasetStats: {
          source: 'upload',
          rawFileCount: files.length,
          ...(consent ? { consentVersion: consent.version, consentAcceptedAt: consent.acceptedAt } : {}),
        },
      });
      setSessionId(res.data.sessionId);
      restoredSessionRef.current = res.data.sessionId;
      connect(res.data.sessionId, { initialStatus: 'waiting' });
      setFiles([]);
      showNotice({ title: `Training ${expName}`, message: "Started. We'll email you when it's done.", tone: 'success' });
    } catch (err) {
      const code = err.response?.data?.code;
      const message = err.response?.data?.error || err.message;
      if (code === 'TRAINING_BUSY') refreshTrainingState();
      setStartError(message);
      showNotice({ title: 'Training could not start', message, tone: 'error' });
    } finally {
      setUploading(false);
    }
  }

  async function handleStop() {
    if (!sessionId) return;
    disconnect();
    reset();
    const stopping = sessionId;
    setSessionId(null);
    restoredSessionRef.current = null;
    showNotice({ title: 'Training stopped', message: 'The run has been stopped.', tone: 'success' });
    try {
      await stopTraining(stopping);
    } catch (err) {
      showNotice({ title: 'Could not stop training', message: err.response?.data?.error || err.message, tone: 'error' });
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  const canStart = !uploading && !isRunning && !blockedByOther && files.length > 0 && identity.valid;
  const latestVoice = voices.reduce((best, voice) => {
    const at = (v) => Date.parse(v?.updatedAt || v?.activatedAt || '') || 0;
    return !best || at(voice) > at(best) ? voice : best;
  }, null);

  return (
    <div className="flex flex-col gap-6">
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Train a voice</h1>
        <p className="mt-1 text-sm text-slate-600">
          Upload recordings of yourself, start training, and we email you when your voice is ready to test.
        </p>
      </div>

      {blockedByOther ? (
        <div role="status" className="flex flex-wrap items-start gap-3 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Clock3 size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Another lecturer is training a voice right now</p>
            <p className="mt-0.5 text-amber-800">
              Only one voice can train at a time.
              {otherRun?.stepsTotal ? ` Step ${Math.min(otherRun.stepsDone + 1, otherRun.stepsTotal)} of ${otherRun.stepsTotal}` : ''}
              {otherRun?.currentStep ? ` (${otherRun.currentStep})` : ''}
              {otherRun?.startedAt ? `, ${formatElapsed(otherRun.startedAt)}` : ''}.
              {' '}You can prepare your files now; Start opens automatically when it finishes. Testing your existing voices still works.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          {!config.authEnabled ? (
            <section className="border border-slate-200 bg-white p-5">
              <SectionHeading step="00" title="NTU email" hint="Sign-in is off in this build, so type the owner email." />
              <input
                type="email"
                value={typedEmail}
                onChange={(e) => setTypedEmail(e.target.value)}
                placeholder="you@ntu.edu.sg"
                className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm"
              />
            </section>
          ) : null}

          <section data-tour="upload" className="border border-slate-200 bg-white p-5">
            <SectionHeading step="01" title="Add your recordings" hint="Several files are fine — they are combined into one voice." />
            <Dropzone onAdd={addFiles} disabled={isRunning || uploading} />
            {fileError ? <p className="mt-2 text-xs text-red-700" role="alert">{fileError}</p> : null}
            {files.length > 0 ? (
              <ul className="mt-4 divide-y divide-slate-100 border border-slate-200">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex items-center gap-3 px-3 py-2.5">
                    <AudioLines size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{file.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">{formatSize(file.size || 0)}</span>
                    <button
                      type="button"
                      onClick={() => setFiles(files.filter((_, i) => i !== index))}
                      disabled={isRunning || uploading}
                      className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
                <li className="flex justify-between bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
                  <span className="tabular-nums">{formatSize(totalBytes)}</span>
                </li>
              </ul>
            ) : null}
          </section>

          <section data-tour="start-training" className="border border-slate-200 bg-white p-5">
            <SectionHeading
              step="02"
              title="Start training"
              hint={identity.valid
                ? `Your voice is saved under ${email}. Each run adds a new version; nothing is replaced.`
                : 'Sign in with your NTU account to train.'}
            />

            {isRunning || pipelineStatus === 'complete' || pipelineStatus === 'error' ? (
              <div className="mb-4 border border-slate-200 bg-slate-50 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-900">
                    {pipelineStatus === 'complete' ? 'Training complete' : pipelineStatus === 'error' ? 'Training stopped with an error' : 'Training in progress'}
                    {runningExpName ? <span className="font-normal text-slate-500"> · {runningExpName}</span> : null}
                  </span>
                  {pipelineStatus === 'complete' && runningExpName ? (
                    <Link to={`/test-voice?voice=${encodeURIComponent(runningExpName)}`} className="text-sm font-medium text-primary hover:underline">
                      Test this voice →
                    </Link>
                  ) : null}
                </div>
                <ProgressTracker steps={steps} />
                {isRunning ? (
                  <p className="mt-1 text-xs text-slate-500">
                    This usually takes 30–60 minutes. You can close this page — we email {email} when it finishes, with a link to test it.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              {!isRunning ? (
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={!canStart}
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {uploading ? <Spinner size={15} className="text-white" /> : <Play size={15} />}
                  {uploading ? 'Uploading…' : 'Start training'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStop}
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300 bg-white px-5 text-sm font-semibold text-red-700 hover:bg-red-50"
                >
                  <Square size={14} />
                  Stop training
                </button>
              )}
              {!isRunning && !canStart && !uploading ? (
                <span className="text-xs text-slate-500">
                  {blockedByOther
                    ? 'Waiting for the current training to finish.'
                    : files.length === 0
                      ? 'Add at least one recording to start.'
                      : ''}
                </span>
              ) : null}
            </div>

            {connectionLost && isRunning ? (
              <p role="status" className="mt-3 flex items-start gap-1.5 text-xs text-amber-800">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                Lost contact with the progress stream. Reconnecting — your training has not been cancelled.
              </p>
            ) : null}
            {(error || startError) ? (
              <p role="alert" className="mt-3 flex items-start gap-1.5 text-sm text-red-700">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {startError || error}
              </p>
            ) : null}

            {SHOW_ADVANCED_SETTINGS ? (
              <Collapsible open={showSettings} onOpenChange={setShowSettings} className="mt-5 border-t border-slate-100 pt-4">
                <CollapsibleTrigger asChild>
                  <button type="button" className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900">
                    <ChevronDown size={14} className={cn('transition-transform', showSettings && 'rotate-180')} />
                    Advanced settings
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-4 grid gap-5 md:grid-cols-2">
                    <SettingSlider label="Batch size" value={batchSize} min={1} max={4} onChange={setBatchSize} disabled={isRunning} />
                    <div className="space-y-2">
                      <span className="text-xs font-medium text-slate-600">Speech language</span>
                      <Select value={asrLanguage} onValueChange={setAsrLanguage} disabled={isRunning}>
                        <SelectTrigger className="h-9 rounded-md border-slate-300 bg-white shadow-none"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="en">English</SelectItem>
                          <SelectItem value="zh">Chinese</SelectItem>
                          <SelectItem value="ja">Japanese</SelectItem>
                          <SelectItem value="ko">Korean</SelectItem>
                          <SelectItem value="auto">Auto detect</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <SettingSlider label="SoVITS epochs" value={sovitsEpochs} min={1} max={50} onChange={setSovitsEpochs} disabled={isRunning} />
                    <SettingSlider label="GPT epochs" value={gptEpochs} min={1} max={50} onChange={setGptEpochs} disabled={isRunning} />
                    <SettingSlider label="SoVITS save interval" value={sovitsSaveEvery} suffix=" ep" min={1} max={10} onChange={setSovitsSaveEvery} disabled={isRunning} />
                    <SettingSlider label="GPT save interval" value={gptSaveEvery} suffix=" ep" min={1} max={10} onChange={setGptSaveEvery} disabled={isRunning} />
                    <label className="flex items-start justify-between gap-3 md:col-span-2">
                      <span>
                        <span className="text-xs font-medium text-slate-600">Skip noise removal</span>
                        <span className="mt-1 block text-xs text-slate-500">For studio-clean recordings only; noise removal can add a slight rasp to clean audio.</span>
                      </span>
                      <Checkbox checked={skipDenoise} onCheckedChange={(v) => setSkipDenoise(v === true)} disabled={isRunning} />
                    </label>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <section className="border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">What makes a good recording</h2>
            <ul className="mt-3 space-y-2">
              {UPLOAD_TIPS.map((tip) => (
                <li key={tip} className="flex gap-2 text-sm leading-6 text-slate-600">
                  <CheckCircle2 size={15} className="mt-1 shrink-0 text-primary" aria-hidden="true" />
                  {tip}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-5 text-slate-500">A recorded lecture with student questions cut out is ideal.</p>
          </section>

          {config.authEnabled ? (
            <section data-tour="your-voices" className="border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
                <h2 className="text-sm font-semibold text-slate-900">Your voices</h2>
                {latestVoice ? (
                  <Link to={`/test-voice?voice=${encodeURIComponent(latestVoice.displayName)}`} className="text-xs font-medium text-primary hover:underline">
                    Test latest →
                  </Link>
                ) : null}
              </div>
              {voicesLoading ? (
                <p className="px-5 py-4 text-sm text-slate-500">Loading…</p>
              ) : voices.length === 0 ? (
                <p className="px-5 py-4 text-sm text-slate-500">None yet. Your first trained voice appears here.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {voices.map((voice) => (
                    <li key={voice.voiceProfileId || voice.displayName} className="flex items-center justify-between gap-2 px-5 py-2.5">
                      <span className="truncate text-sm text-slate-800">{voice.displayName}</span>
                      <Link
                        to={`/test-voice?voice=${encodeURIComponent(voice.displayName)}`}
                        className="shrink-0 text-xs font-medium text-primary hover:underline"
                      >
                        Test
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
