import React from 'react';
import { 
  Flame, 
  RefreshCw, 
  Settings as SettingsIcon, 
  Terminal, 
  Calendar, 
  BarChart3, 
  Layers, 
  History as HistoryIcon 
} from 'lucide-react';
import { CFUser, SyncStatus } from '../types';
import { getRankBadgeBg, getRankColor, formatDateHebron } from '../utils';

interface HeaderProps {
  user: CFUser | null;
  syncStatus: SyncStatus;
  activeTab: 'dashboard' | 'training' | 'topics' | 'history' | 'settings';
  setActiveTab: (tab: 'dashboard' | 'training' | 'topics' | 'history' | 'settings') => void;
  streakDays: number;
  onSync: () => void;
  isSyncing: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  syncStatus,
  activeTab,
  setActiveTab,
  streakDays,
  onSync,
  isSyncing,
}) => {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo and User Quick Info */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setActiveTab('dashboard')}>
              <div className="p-2 bg-gradient-to-tr from-cyan-600 to-blue-600 rounded-lg shadow-md shadow-cyan-950/50">
                <Terminal className="w-5 h-5 text-white" />
              </div>
              <div>
                <span className="text-base font-bold tracking-tight text-white flex items-center gap-1.5">
                  CP Coach
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/60 uppercase">
                    Personal
                  </span>
                </span>
                <p className="text-[11px] text-slate-400 font-mono">Asia/Hebron</p>
              </div>
            </div>

            {user && (
              <div className="hidden md:flex items-center gap-2.5 pl-4 border-l border-slate-800">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.handle} className="w-7 h-7 rounded-full border border-slate-700 object-cover" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300">
                    {user.handle[0]}
                  </div>
                )}
                <div>
                  <a 
                    href={`https://codeforces.com/profile/${user.handle}`}
                    target="_blank" 
                    rel="noreferrer"
                    className={`text-xs font-semibold hover:underline ${getRankColor(user.rating, user.rank)}`}
                  >
                    {user.handle}
                  </a>
                  <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded border ${getRankBadgeBg(user.rating, user.rank)}`}>
                    {user.rating || 'Unrated'} {user.rank ? `(${user.rank})` : ''}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Navigation Tabs */}
          <nav className="hidden lg:flex items-center gap-1">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <BarChart3 className="w-4 h-4 text-cyan-400" />
              Dashboard
            </button>

            <button
              onClick={() => setActiveTab('training')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === 'training'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Calendar className="w-4 h-4 text-emerald-400" />
              Today's Training
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            </button>

            <button
              onClick={() => setActiveTab('topics')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === 'topics'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Layers className="w-4 h-4 text-amber-400" />
              Topic Analysis
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === 'history'
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <HistoryIcon className="w-4 h-4 text-purple-400" />
              History
            </button>
          </nav>

          {/* Actions: Streak, Sync, Settings */}
          <div className="flex items-center gap-2.5">
            {/* Streak */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-950/40 border border-amber-800/40 text-amber-300 text-xs font-semibold">
              <Flame className="w-4 h-4 text-amber-400 fill-amber-400/20" />
              <span>{streakDays}d streak</span>
            </div>

            {/* Sync Button */}
            <button
              onClick={onSync}
              disabled={isSyncing}
              title={`Last synced: ${formatDateHebron(syncStatus.lastSyncedAt)}`}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all border ${
                isSyncing 
                  ? 'bg-slate-800 text-slate-400 border-slate-700 cursor-not-allowed'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700/80 active:scale-95'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isSyncing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">
                {isSyncing ? 'Syncing...' : 'Sync CF'}
              </span>
            </button>

            {/* Settings Button */}
            <button
              onClick={() => setActiveTab('settings')}
              className={`p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all ${
                activeTab === 'settings' ? 'bg-slate-800 text-white' : ''
              }`}
              title="Settings"
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Mobile Sub-Navigation */}
        <div className="flex lg:hidden overflow-x-auto py-2 gap-1 border-t border-slate-800/60 no-scrollbar">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap ${
              activeTab === 'dashboard' ? 'bg-slate-800 text-white font-medium' : 'text-slate-400'
            }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('training')}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap flex items-center gap-1 ${
              activeTab === 'training' ? 'bg-slate-800 text-white font-medium' : 'text-slate-400'
            }`}
          >
            Today's 3
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          </button>
          <button
            onClick={() => setActiveTab('topics')}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap ${
              activeTab === 'topics' ? 'bg-slate-800 text-white font-medium' : 'text-slate-400'
            }`}
          >
            Topics
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-3 py-1 rounded text-xs whitespace-nowrap ${
              activeTab === 'history' ? 'bg-slate-800 text-white font-medium' : 'text-slate-400'
            }`}
          >
            History
          </button>
        </div>
      </div>
    </header>
  );
};
