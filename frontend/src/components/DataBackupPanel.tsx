import React, { useRef, useState } from 'react';
import { Download, FileUp, ShieldCheck } from 'lucide-react';
import { BackupMode, MAX_BROWSER_BACKUP_BYTES } from '../dataBackup';
import { exportBrowserData, importBrowserData } from '../api';

interface Props {
  enabled: boolean;
  onImported: () => Promise<void>;
}

export const DataBackupPanel: React.FC<Props> = ({ enabled, onImported }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<BackupMode>('merge');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const backup = await exportBrowserData();
      const serialized = JSON.stringify(backup, null, 2);
      if (new TextEncoder().encode(serialized).byteLength > MAX_BROWSER_BACKUP_BYTES) {
        throw new Error('Complete backup exceeds the 10 MB download limit. No partial export was created.');
      }
      const blob = new Blob([serialized], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cp-coach-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported learning data for ${backup.profiles.length} profile(s).`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Backup export failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (file.size > MAX_BROWSER_BACKUP_BYTES) throw new Error('Backup file is larger than the 10 MB limit.');
      const backup: unknown = JSON.parse(await file.text());
      const action = mode === 'replace' ? 'replace existing learning data' : 'merge with existing learning data';
      if (!window.confirm(`Import this backup and ${action}? This affects only matching Codeforces profiles in this browser.`)) {
        return;
      }
      await importBrowserData(backup, mode);
      await onImported();
      setMessage(`Backup imported successfully (${mode}).`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Backup import failed. Existing data was preserved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-emerald-400 mt-0.5" />
        <div>
          <h3 className="text-xs font-semibold text-slate-200">Learning Data Backup</h3>
          <p className="text-xs text-slate-500 mt-1">
            {enabled
              ? 'Export all saved browser profiles to a versioned JSON file. Keep a copy somewhere safe.'
              : 'Portable browser backup is available in public browser-local mode. Your local SQLite database remains on this computer.'}
          </p>
        </div>
      </div>
      {enabled && (
        <>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={handleExport}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-white disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
              {busy ? 'Working...' : 'Export JSON'}
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Import mode
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as BackupMode)}
                disabled={busy}
                className="px-2 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200"
              >
                <option value="merge">Merge (keep existing records)</option>
                <option value="replace">Replace matching profiles</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-xs text-white disabled:opacity-50"
            >
              <FileUp className="w-3.5 h-3.5" />
              Import backup
            </button>
            <input ref={fileInput} type="file" accept="application/json,.json" onChange={handleFile} className="hidden" />
          </div>
          <p className="text-[11px] text-slate-500">
            Imports are schema-validated before changing data. Merge and replace both require confirmation; failed imports restore the browser's prior snapshot.
          </p>
        </>
      )}
      {message && <p role="status" className="text-xs text-emerald-400">{message}</p>}
      {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
    </section>
  );
};
