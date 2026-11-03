import React, { useEffect, useRef, useState } from 'react';
import AudioUploader from '../components/AudioUploader.jsx';
import FloatingNotice from '../components/FloatingNotice.jsx';
import TrainingLibraryPanel from '../components/TrainingLibraryPanel.jsx';
import {
  deleteTrainingLibraryFile,
  allocateTrainingVoiceName,
  getCurrentTraining,
  getModels,
  getTrainingLibraryFiles,
  replaceTrainingLibraryFile,
  snapshotTrainingLibraryFiles,
  startTraining,
  stopTraining,
  uploadFiles,
  uploadTrainingLibraryFile,
} from '../services/api.js';
import { useSSE } from '../hooks/useSSE.js';
import { validateTrainingStart } from '@/lib/trainingValidation';
import { describeVoiceIdentity, nextVoiceName, ownsVoiceName } from '@/lib/voiceIdentity';
import { buildVoiceProfiles } from '@/lib/voiceProfiles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertCircle, AudioLines, ChevronDown, Play, Square, X } from 'lucide-react';
import Spinner from '../components/Spinner.jsx';
import { cn } from '@/lib/utils';
import { getStorageMode } from '@/lib/runtimeConfig';
import { describeTrainingSelection, resolveTrainingSource } from '@/lib/trainingSource';

const NOTICE_TIMEOUT_MS = 4200;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export default function TrainingPage() {
  const [email, setEmail] = useState('');
  const [runningExpName, setRunningExpName] = useState('');
  const [existingVoiceNames, setExistingVoiceNames] = useState([]);
  const [files, setFiles] = useState([]);
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
  const [uploadError, setUploadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [storageMode, setStorageMode] = useState('loading');
  const [trainingLibraryFiles, setTrainingLibraryFiles] = useState([]);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [uploadingLibrary, setUploadingLibrary] = useState(false);
  const [replacingLibraryId, setReplacingLibraryId] = useState('');
  const [deletingLibraryId, setDeletingLibraryId] = useState('');

  const { pipelineStatus, error, connectionLost, connect, disconnect, hydrate, reset } = useSSE();
  const restoredSessionRef = useRef(null);
  const noticeTimeoutRef = useRef(null);
  const previousStatusRef = useRef(null);
  const noticesReadyRef = useRef(false);
  const canvasRef = useRef(null);

  const isRunning = pipelineStatus === 'running' || pipelineStatus === 'waiting';
  // The voice is named after the lecturer's email so the faculty app can find
  // it from their sign-in alone, and every run adds another one. This is only
  // the preview — the name that is actually used is allocated by the server at
  // start, so an out-of-date model list here can never overwrite a voice.
  const voiceIdentity = describeVoiceIdentity(email);
  const showIdentityError = Boolean(email.trim()) && !voiceIdentity.valid;
  const previewVoiceName = voiceIdentity.valid
    ? nextVoiceName(voiceIdentity.email, existingVoiceNames)
    : '';
  const ownedVoiceNames = voiceIdentity.valid
    ? existingVoiceNames.filter((name) => ownsVoiceName(voiceIdentity.email, name))
    : [];
  const trainingSource = resolveTrainingSource({
    directFiles: files,
    selectedLibraryIds,
  });
  const selectionSummary = describeTrainingSelection({
    directFiles: files,
    selectedLibraryIds,
  });
  const statusLabel = pipelineStatus === 'running'
    ? 'Training in progress'
    : pipelineStatus === 'waiting'
      ? 'Waiting for pipeline'
      : pipelineStatus === 'complete'
        ? 'Training complete'
        : pipelineStatus === 'error'
          ? 'Needs attention'
          : pipelineStatus === 'stopped'
            ? 'Stopped'
            : 'idle';

  function showNotice({ title, message = '', tone = 'success' }) {
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    const id = Date.now();
    setNotice({ id, title, message, tone });
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice((current) => (current?.id === id ? null : current));
    }, NOTICE_TIMEOUT_MS);
  }

  async function refreshTrainingLibrary() {
    setLoadingLibrary(true);
    try {
      const response = await getTrainingLibraryFiles();
      const nextFiles = response.data?.files || [];
      setTrainingLibraryFiles(nextFiles);
      setSelectedLibraryIds((current) => current.filter((id) => nextFiles.some((file) => file.id === id)));
    } catch (err) {
      showNotice({
        title: 'Shared storage unavailable',
        message: err.response?.data?.error || err.message || 'Could not load shared storage files.',
        tone: 'error',
      });
    } finally {
      setLoadingLibrary(false);
    }
  }

  useEffect(() => {
    let ignore = false;

    // Only feeds the name preview, so a failure here is silent — it must never
    // stop someone training.
    async function loadExistingVoices() {
      try {
        const res = await getModels();
        if (ignore) return;
        setExistingVoiceNames(buildVoiceProfiles(res.data?.gpt || [], res.data?.sovits || [])
          .map((profile) => profile.expName)
          .filter(Boolean));
      } catch {
        if (!ignore) setExistingVoiceNames([]);
      }
    }

    loadExistingVoices();
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    let ignore = false;

    async function restoreTrainingState() {
      try {
        const res = await getCurrentTraining();
        const current = res.data;
        if (ignore || !current?.sessionId) return;

        setSessionId(current.sessionId);
        setRunningExpName(current.expName || '');

        if (current.sessionId === restoredSessionRef.current) return;

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
        previousStatusRef.current = current.status || 'idle';
      } catch (err) {
        console.error('Failed to restore training state:', err);
      } finally {
        noticesReadyRef.current = true;
        if (previousStatusRef.current === null) {
          previousStatusRef.current = 'idle';
        }
      }
    }

    restoreTrainingState();

    return () => {
      ignore = true;
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    };
  }, [connect, disconnect, hydrate]);

  useEffect(() => {
    let ignore = false;

    async function loadStorageMode() {
      const mode = await getStorageMode();
      if (ignore) return;
      setStorageMode(mode);
      if (mode === 's3') {
        await refreshTrainingLibrary();
      }
    }

    loadStorageMode();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!noticesReadyRef.current) return;
    const previousStatus = previousStatusRef.current;
    if (previousStatus === null) {
      previousStatusRef.current = pipelineStatus;
      return;
    }
    if (pipelineStatus !== previousStatus) {
      if (pipelineStatus === 'complete') {
        showNotice({
          title: 'Training complete',
          message: 'Your checkpoints are ready. Open the inference studio to use your new voice.',
          tone: 'success',
        });
      } else if (pipelineStatus === 'error') {
        showNotice({
          title: 'Training needs attention',
          message: error || 'The pipeline stopped before finishing.',
          tone: 'error',
        });
      }
    }
    previousStatusRef.current = pipelineStatus;
  }, [pipelineStatus, error]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let rafId;
    let dots = [];
    const mouse = { x: -999, y: -999 };
    let lastTime = null;

    // Fix #7: hoist physics constants to useEffect scope
    const REPEL = 90, SPRING = 0.12, DAMP = 0.75;

    function buildGrid() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      canvas.width = W;
      canvas.height = H;
      lastTime = null;

      // Fix #3: adapt spacing for high-DPI / 4K screens
      const spacing = window.devicePixelRatio > 1.5 ? 48 : 32;
      const cols = Math.floor(W / spacing) + 1;
      const rows = Math.floor(H / spacing) + 1;
      const offX = (W - (cols - 1) * spacing) / 2;
      const offY = (H - (rows - 1) * spacing) / 2;

      dots = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ox = offX + c * spacing;
          const oy = offY + r * spacing;
          dots.push({ ox, oy, x: ox, y: oy, vx: 0, vy: 0 });
        }
      }
    }

    // Fix #1: delta-time compensation so physics is frame-rate independent
    function draw(timestamp) {
      const dt = lastTime === null ? 16.67 : timestamp - lastTime;
      lastTime = timestamp;
      const scale = dt / 16.67;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const d of dots) {
        const dx = d.x - mouse.x;
        const dy = d.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        d.vx += (d.ox - d.x) * SPRING * scale;
        d.vy += (d.oy - d.y) * SPRING * scale;

        if (dist < REPEL && dist > 0) {
          const force = (REPEL - dist) / REPEL * 2.8 * scale;
          d.vx += (dx / dist) * force;
          d.vy += (dy / dist) * force;
        }

        d.vx *= Math.pow(DAMP, scale);
        d.vy *= Math.pow(DAMP, scale);
        d.x += d.vx;
        d.y += d.vy;
      }

      // Fix #2: batch dots by colour bucket to reduce fillStyle thrashing
      const buckets = new Array(11).fill(null).map(() => []);
      for (const d of dots) {
        const displaced = Math.sqrt((d.x - d.ox) ** 2 + (d.y - d.oy) ** 2);
        const t = Math.min(displaced / 16, 1);
        buckets[Math.round(t * 10)].push(d);
      }
      for (let i = 0; i <= 10; i++) {
        const bucket = buckets[i];
        if (bucket.length === 0) continue;
        const t = i / 10;
        const alpha = 0.35 + t * 0.45;
        const radius = 1.2 + t * 1.4;
        const r = Math.round(148 + t * (99 - 148));
        const g = Math.round(163 + t * (102 - 163));
        const b = Math.round(184 + t * (241 - 184));
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath();
        for (const d of bucket) {
          ctx.moveTo(d.x + radius, d.y);
          ctx.arc(d.x, d.y, radius, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      // Fix #4: guard against sentinel value -999, not > 0
      if (mouse.x !== -999) {
        const grd = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 70);
        grd.addColorStop(0, 'rgba(99,102,241,0.10)');
        grd.addColorStop(1, 'rgba(99,102,241,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 70, 0, Math.PI * 2);
        ctx.fill();
      }

      rafId = requestAnimationFrame(draw);
    }

    function onMouseMove(e) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }

    // Debounce resize to avoid rapid grid rebuilds mid-frame
    buildGrid();
    rafId = requestAnimationFrame(draw);
    window.addEventListener('mousemove', onMouseMove);
    let resizeTimer;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(buildGrid, 100);
    }
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMouseMove);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  function handleDirectFilesChange(nextFiles) {
    setFiles(nextFiles);
    if (nextFiles.length > 0 && selectedLibraryIds.length > 0) {
      setSelectedLibraryIds([]);
    }
  }

  function handleToggleLibrarySelection(fileId, checked) {
    if (checked) {
      if (files.length > 0) {
        setFiles([]);
      }
      setSelectedLibraryIds((current) => (current.includes(fileId) ? current : [...current, fileId]));
      return;
    }

    setSelectedLibraryIds((current) => current.filter((id) => id !== fileId));
  }

  async function handleUploadLibraryFiles(nextFiles) {
    if (nextFiles.length === 0) return;
    setUploadingLibrary(true);
    try {
      for (const file of nextFiles) {
        await uploadTrainingLibraryFile(file);
      }
      await refreshTrainingLibrary();
      showNotice({
        title: 'Shared storage updated',
        message: `${nextFiles.length} file${nextFiles.length === 1 ? '' : 's'} uploaded to shared storage.`,
        tone: 'success',
      });
    } catch (err) {
      showNotice({
        title: 'Shared storage upload failed',
        message: err.response?.data?.error || err.message || 'Could not upload to shared storage.',
        tone: 'error',
      });
    } finally {
      setUploadingLibrary(false);
    }
  }

  async function handleReplaceLibraryFile(fileId, nextFile) {
    setReplacingLibraryId(fileId);
    try {
      await replaceTrainingLibraryFile(fileId, nextFile);
      await refreshTrainingLibrary();
      showNotice({
        title: 'Shared file replaced',
        message: `${nextFile.name} is now the latest version in shared storage.`,
        tone: 'success',
      });
    } catch (err) {
      showNotice({
        title: 'Replace failed',
        message: err.response?.data?.error || err.message || 'Could not replace the shared storage file.',
        tone: 'error',
      });
    } finally {
      setReplacingLibraryId('');
    }
  }

  async function handleDeleteLibraryFile(fileId) {
    setDeletingLibraryId(fileId);
    try {
      await deleteTrainingLibraryFile(fileId);
      setSelectedLibraryIds((current) => current.filter((id) => id !== fileId));
      await refreshTrainingLibrary();
      showNotice({
        title: 'Shared file deleted',
        message: 'The file was removed from shared storage.',
        tone: 'success',
      });
    } catch (err) {
      showNotice({
        title: 'Delete failed',
        message: err.response?.data?.error || err.message || 'Could not delete the shared storage file.',
        tone: 'error',
      });
    } finally {
      setDeletingLibraryId('');
    }
  }

  async function handleStart() {
    const validation = validateTrainingStart({
      email,
      source: trainingSource,
      files,
      selectedLibraryIds,
      batchSize,
      sovitsEpochs,
      gptEpochs,
      sovitsSaveEvery,
      gptSaveEvery,
      asrLanguage,
    });
    if (!validation.valid) {
      const message = validation.errors.join(' ');
      setUploadError(message);
      showNotice({ title: 'Check training setup', message, tone: 'error' });
      return;
    }

    const { email: notifyEmail } = validation;
    setUploadError(null);
    setUploading(true);
    try {
      // Ask the server for the name before uploading anything: the audio lands
      // under training/datasets/<expName>/raw/, so guessing here is what would
      // let a stale model list write into an existing voice.
      const allocation = await allocateTrainingVoiceName(notifyEmail);
      const expName = String(allocation.data?.expName || '').trim();
      if (!expName) throw new Error('The server did not return a name for this voice.');
      setExistingVoiceNames((names) => (names.includes(expName) ? names : [...names, expName]));
      setRunningExpName(expName);

      if (trainingSource === 'library') {
        await snapshotTrainingLibraryFiles(expName, selectedLibraryIds);
      } else {
        await uploadFiles(expName, files);
      }
      const res = await startTraining({
        expName,
        email: notifyEmail,
        batchSize,
        sovitsEpochs,
        gptEpochs,
        sovitsSaveEvery,
        gptSaveEvery,
        asrLanguage,
        skipDenoise,
        sourceDatasetStats: {
          source: trainingSource,
          rawFileCount: trainingSource === 'library' ? selectedLibraryIds.length : files.length,
        },
      });
      setSessionId(res.data.sessionId);
      restoredSessionRef.current = res.data.sessionId;
      connect(res.data.sessionId, { initialStatus: 'waiting' });
      showNotice({
        title: `Training ${expName}`,
        message: "Training has started and we'll email you when it's done.",
        tone: 'success',
      });
    } catch (err) {
      setUploadError(err.response?.data?.error || err.message);
      showNotice({ title: 'Training could not start', message: err.response?.data?.error || err.message, tone: 'error' });
    } finally {
      setUploading(false);
    }
  }

  async function handleStop() {
    if (!sessionId) return;
    disconnect();
    reset();
    setSessionId(null);
    restoredSessionRef.current = null;
    showNotice({ title: 'Training stopped', message: 'The current run has been stopped.', tone: 'success' });
    try {
      await stopTraining(sessionId);
    } catch (err) {
      console.error('Failed to stop training:', err);
    }
  }

  function removeFile(index) {
    setFiles(files.filter((_, i) => i !== index));
  }

  return (
    <div className="animate-fade-in flex min-h-0 flex-1 flex-col justify-center py-8">
      <canvas
        ref={canvasRef}
        style={{ position: 'fixed', inset: 0, zIndex: -5, pointerEvents: 'none' }}
        aria-hidden="true"
      />
      <FloatingNotice notice={notice} onClose={() => setNotice(null)} />

      {/* Page title */}
      <div className="mb-10">
        <h1 className="text-4xl font-bold tracking-tight">
          <span className="bg-gradient-to-br from-slate-900 via-slate-800 to-primary/80 bg-clip-text text-transparent">
            Train a voice
          </span>
        </h1>
        <p className="mt-2 text-base text-slate-500">Enter your NTU email, upload audio clips, and start.</p>
      </div>

      {/* Two-column form */}
      <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,8fr)_minmax(0,11fr)]">
        {/* Left: fields */}
        <div className="space-y-7">
          <div className="space-y-2">
            <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              NTU Email
            </Label>
            <Input
              type="email"
              className={cn(
                'h-12 rounded-xl border-slate-200 bg-white text-sm shadow-none focus-visible:ring-1',
                showIdentityError && 'border-red-300 focus-visible:ring-red-300'
              )}
              placeholder="you@ntu.edu.sg"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isRunning}
              aria-invalid={showIdentityError || undefined}
              aria-describedby="training-voice-name"
            />
            <p id="training-voice-name" className="text-xs text-slate-500">
              Every run creates another voice named after this address. We email you here when it finishes.
            </p>
          </div>

          <div
            className={cn(
              'rounded-xl border px-4 py-3 text-xs',
              showIdentityError
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-slate-200 bg-slate-50 text-slate-600'
            )}
            role={showIdentityError ? 'alert' : undefined}
          >
            {showIdentityError ? (
              voiceIdentity.error
            ) : previewVoiceName ? (
              <>
                This run will be saved as <span className="font-semibold">{previewVoiceName}</span>.
                {ownedVoiceNames.length > 0 ? (
                  <> You already have {ownedVoiceNames.length === 1 ? '1 voice' : `${ownedVoiceNames.length} voices`}; none of them are replaced.</>
                ) : (
                  ' It will be your first voice.'
                )}
              </>
            ) : (
              'Enter your NTU email to see what this voice will be called.'
            )}
          </div>
        </div>

        {/* Right: upload zone */}
        <div className="space-y-2">
          <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            Audio Clips
          </Label>
          <AudioUploader files={files} onFilesChange={handleDirectFilesChange} disabled={isRunning} />
          <TrainingLibraryPanel
            files={trainingLibraryFiles}
            selectedIds={selectedLibraryIds}
            storageMode={storageMode}
            loading={loadingLibrary}
            uploadBusy={uploadingLibrary}
            replaceBusyId={replacingLibraryId}
            deleteBusyId={deletingLibraryId}
            disabled={isRunning}
            onUploadFiles={handleUploadLibraryFiles}
            onToggleSelect={handleToggleLibrarySelection}
            onReplaceFile={handleReplaceLibraryFile}
            onDeleteFile={handleDeleteLibraryFile}
          />
        </div>
      </div>

      {/* File list - full width */}
      {files.length > 0 && (
        <div className="mt-8">
          {files.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center gap-4 border-b border-slate-100 py-3 last:border-0"
            >
              <AudioLines size={15} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{f.name}</span>
              <span className="shrink-0 text-xs text-slate-400">{formatSize(f.size || 0)}</span>
              <button
                type="button"
                className={cn(
                  'shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:text-slate-700',
                  isRunning && 'cursor-not-allowed opacity-40'
                )}
                onClick={() => removeFile(i)}
                disabled={isRunning}
                title="Remove file"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Action bar */}
      <div className="mt-10 flex flex-wrap items-center gap-4">
        {!isRunning ? (
          <Button
            onClick={handleStart}
            disabled={uploading || isRunning}
            className="h-12 rounded-full px-8 text-sm font-semibold shadow-lg shadow-primary/25 [background:linear-gradient(135deg,hsl(224,85%,58%)_0%,hsl(250,80%,62%)_100%)] hover:shadow-primary/35 hover:opacity-95 transition-all"
          >
            {uploading ? (
              <>
                <Spinner size={15} className="text-primary-foreground" />
                Uploading...
              </>
            ) : (
              <>
                <Play size={15} />
                Start training
              </>
            )}
          </Button>
        ) : (
          <Button
            variant="destructive"
            className="h-12 rounded-full px-8 text-sm font-semibold shadow-none"
            onClick={handleStop}
          >
            <Square size={15} />
            Stop training
          </Button>
        )}

        <span className="flex items-center gap-2 text-sm text-slate-500">
          <span className={cn(
            'h-2 w-2 rounded-full',
            pipelineStatus === 'running' ? 'bg-blue-500' :
            pipelineStatus === 'complete' ? 'bg-emerald-500' :
            pipelineStatus === 'error' ? 'bg-red-500' :
            'bg-slate-300'
          )} />
          {selectionSummary} - {statusLabel}
          {runningExpName && isRunning ? (
            <span className="text-slate-400">({runningExpName})</span>
          ) : null}
        </span>

        {connectionLost && isRunning && (
          <span role="status" className="flex items-center gap-1.5 text-sm text-amber-700">
            <AlertCircle size={14} />
            Lost contact with the GPU progress stream. Reconnecting — the GPU may have stopped or still be starting. Your job has not been cancelled.
          </span>
        )}

        {(error || uploadError) && (
          <span className="flex items-center gap-1.5 text-sm text-red-600">
            <AlertCircle size={14} />
            {error || uploadError}
          </span>
        )}
      </div>

      {/* Additional settings collapsible */}
      <Collapsible open={showSettings} onOpenChange={setShowSettings} className="mt-12">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-700"
          >
            <ChevronDown
              size={15}
              className={cn('transition-transform', showSettings && 'rotate-180')}
            />
            {showSettings ? 'Hide' : 'Show'} additional settings
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-6 grid grid-cols-1 gap-5 rounded-2xl border border-slate-100 bg-slate-50 p-6 md:grid-cols-2 md:gap-x-8">
            {/* Batch Size */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Batch Size</Label>
                <span className="font-mono text-sm font-semibold text-slate-700">{batchSize}</span>
              </div>
              <Slider min={1} max={4} step={1} value={[batchSize]} onValueChange={([v]) => setBatchSize(v)} disabled={isRunning} />
            </div>

            {/* ASR Language */}
            <div className="space-y-3">
              <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">ASR Language</Label>
              <Select value={asrLanguage} onValueChange={setAsrLanguage} disabled={isRunning}>
                <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white shadow-none"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="zh">Chinese</SelectItem>
                  <SelectItem value="ja">Japanese</SelectItem>
                  <SelectItem value="ko">Korean</SelectItem>
                  <SelectItem value="auto">Auto Detect</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* SoVITS Epochs */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">SoVITS Epochs</Label>
                <span className="font-mono text-sm font-semibold text-slate-700">{sovitsEpochs}</span>
              </div>
              <Slider min={1} max={50} step={1} value={[sovitsEpochs]} onValueChange={([v]) => setSovitsEpochs(v)} disabled={isRunning} />
            </div>

            {/* GPT Epochs */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">GPT Epochs</Label>
                <span className="font-mono text-sm font-semibold text-slate-700">{gptEpochs}</span>
              </div>
              <Slider min={1} max={50} step={1} value={[gptEpochs]} onValueChange={([v]) => setGptEpochs(v)} disabled={isRunning} />
            </div>

            {/* SoVITS Save Interval */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">SoVITS Save Interval</Label>
                <span className="font-mono text-sm font-semibold text-slate-700">every {sovitsSaveEvery}ep</span>
              </div>
              <Slider min={1} max={10} step={1} value={[sovitsSaveEvery]} onValueChange={([v]) => setSovitsSaveEvery(v)} disabled={isRunning} />
            </div>

            {/* GPT Save Interval */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">GPT Save Interval</Label>
                <span className="font-mono text-sm font-semibold text-slate-700">every {gptSaveEvery}ep</span>
              </div>
              <Slider min={1} max={10} step={1} value={[gptSaveEvery]} onValueChange={([v]) => setGptSaveEvery(v)} disabled={isRunning} />
            </div>

            {/* Skip Denoise toggle */}
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Skip denoise</Label>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    Turn on for already-clean recordings. Denoise removes background noise, but on clean audio it can add a raspy artifact.
                  </p>
                </div>
                <Checkbox
                  className="mt-1"
                  checked={skipDenoise}
                  onCheckedChange={(v) => setSkipDenoise(v === true)}
                  disabled={isRunning}
                />
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
