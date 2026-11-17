import React, { useState, useRef } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

const ACCEPT = '.wav,.mp3,.ogg,.flac,.m4a,.webm,.mp4';

export default function AudioUploader({ files, onFilesChange, disabled }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const dropped = Array.from(e.dataTransfer.files).filter(f =>
      ACCEPT.split(',').some(ext => f.name.toLowerCase().endsWith(ext))
    );
    onFilesChange([...files, ...dropped]);
  }

  function handleSelect(e) {
    const selected = Array.from(e.target.files);
    onFilesChange([...files, ...selected]);
    e.target.value = '';
  }

  return (
    <div>
      <div
        className={cn(
          'flex min-h-[210px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-8 py-10 text-center transition-all',
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-slate-200 hover:border-primary/40 hover:bg-primary/[0.025]',
          disabled && 'cursor-not-allowed opacity-40'
        )}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <Upload
          size={22}
          className={cn('mb-3 transition-colors', dragOver ? 'text-primary' : 'text-slate-400')}
        />
        <p className="text-sm text-slate-700">
          <span className="font-semibold">Click to upload</span> or drag &amp; drop
        </p>
        <p className="mt-1 text-xs text-slate-400">WAV, MP3, FLAC, M4A, OGG, WEBM, MP4 up to 2 GB</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          onChange={handleSelect}
          className="hidden"
          disabled={disabled}
        />
      </div>
      {files.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          {files.length} file{files.length !== 1 ? 's' : ''} queued
        </p>
      )}
    </div>
  );
}
