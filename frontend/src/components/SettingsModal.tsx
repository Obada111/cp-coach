import React, { useState } from 'react';
import { 
  Settings, 
  Save, 
  RefreshCw, 
  ShieldCheck, 
  CheckCircle2, 
  AlertCircle 
} from 'lucide-react';
import { SyncStatus } from '../types';
import { formatDateHebron } from '../utils';

interface SettingsModalProps {
  currentHandle: string;
  syncStatus: SyncStatus;
  onUpdateHandle: (newHandle: string) => Promise<void>;
  onSync: () => Promise<void>;
  isSyncing: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  currentHandle,
  syncStatus,
  onUpdateHandle,
  onSync,
  isSyncing,
}) => {
  const [handleInput, setHandleInput] = useState(currentHandle);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handleInput.trim()) return;
    setIsSaving(true);
    setSaveMessage(null);
    setErrorMessage(null);
    try {
      await onUpdateHandle(handleInput.trim());
      setSaveMessage(`Handle updated to "${handleInput.trim()}". Triggering synchronization...`);
      await onSync();
      setSaveMessage(`Handle updated and synchronized successfully!`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to update handle');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <Settings className="w-4 h-4 text-cyan-400" />
          Settings & Local System Configuration
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Manage your Codeforces profile handle, local SQLite database, and synchronization preferences.
        </p>
      </div>

      {/* Handle Configuration Form */}
      <form onSubmit={handleSave} className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4">
        <div>
          <label className="text-xs font-semibold text-slate-200 block mb-1.5">
            Codeforces Handle
          </label>
          <div className="flex gap-2.5">
            <input
              type="text"
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value)}
              placeholder="e.g. tourist"
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-mono"
            />
            <button
              type="submit"
              disabled={isSaving || handleInput.trim() === currentHandle}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-semibold transition-all active:scale-95"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Updating...' : 'Save & Re-sync'}</span>
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5">
            Changing your handle will fetch and cache that profile's contest history and submissions.
          </p>
        </div>

        {saveMessage && (
          <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-800 text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{saveMessage}</span>
          </div>
        )}

        {errorMessage && (
          <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800 text-xs text-rose-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}
      </form>

      {/* Synchronization Management */}
      <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Data Synchronization</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Pull latest submissions, rating changes, and problems from the official Codeforces API.
            </p>
          </div>
          <button
            onClick={onSync}
            disabled={isSyncing}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-750 border border-slate-700 text-white text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Synchronizing...' : 'Sync Now'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-850 text-xs">
            <span className="text-slate-500 block">Last Synced</span>
            <span className="font-mono text-slate-200 font-medium">
              {formatDateHebron(syncStatus.lastSyncedAt)}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-850 text-xs">
            <span className="text-slate-500 block">Submissions Cached</span>
            <span className="font-mono text-slate-200 font-medium">
              {syncStatus.submissionsCount.toLocaleString()}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-slate-950 border border-slate-850 text-xs">
            <span className="text-slate-500 block">Problemset Database</span>
            <span className="font-mono text-slate-200 font-medium">
              {syncStatus.problemsCount.toLocaleString()} problems
            </span>
          </div>
        </div>
      </div>

      {/* Privacy and Storage Guarantee */}
      <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Privacy & Local Storage Architecture</span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          This application keeps personal training data in your browser and an ephemeral server cache.
          Local mode can also use a SQLite file on your computer.
          It uses only the public Codeforces API and never requires, asks for, or stores passwords.
        </p>
      </div>
    </div>
  );
};
