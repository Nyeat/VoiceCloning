// Super-user training recipe: noise removal, epochs, batch size. Used on the
// record page (before submitting) and in the "Not good — retrain" form.
// Blank number fields mean "use the default / the retrain recipe"; the server
// drops anything out of range (lambda/studio/workflow.js sanitizeTrainingConfig).
import React from 'react';

const NUMBER_FIELDS = [
  ['sovitsEpochs', 'SoVITS epochs', 'sounds like them', 1, 30],
  ['gptEpochs', 'GPT epochs', 'words and rhythm', 1, 50],
  ['batchSize', 'Batch size', '1-4', 1, 4],
];

/** Build the request payload from the form value: numbers only when filled in. */
export function trainingSettingsPayload(value) {
  const out = { skipDenoise: value.skipDenoise !== false };
  for (const [key] of NUMBER_FIELDS) {
    const raw = String(value[key] ?? '').trim();
    if (raw) out[key] = Number(raw);
  }
  return out;
}

export function TrainingSettings({ value, onChange, current = null, disabled = false }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.skipDenoise !== false}
          disabled={disabled}
          onChange={(event) => set({ skipDenoise: event.target.checked })}
        />
        <span>
          <span className="font-medium">Skip noise removal</span>
          <span className="block text-xs text-slate-500">Recommended for quiet-room recordings. Noise removal cuts audio to 16 kHz and adds an echoey, robotic sound; untick only for noisy recordings.</span>
        </span>
      </label>
      <div className="grid grid-cols-3 gap-2">
        {NUMBER_FIELDS.map(([key, label, hint, min, max]) => (
          <label key={key} className="text-xs text-slate-600">
            <span className="font-medium">{label}</span>
            <input
              type="number"
              min={min}
              max={max}
              step={1}
              inputMode="numeric"
              value={value[key] ?? ''}
              disabled={disabled}
              placeholder={current?.[key] != null ? String(current[key]) : 'default'}
              onChange={(event) => set({ [key]: event.target.value })}
              className="mt-1 h-9 w-full rounded-lg border border-slate-300 px-2 text-sm"
            />
            <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
