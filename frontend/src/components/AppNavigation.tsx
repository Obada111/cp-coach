import React from 'react';
import {
  BarChart3,
  BookOpen,
  CalendarDays,
  Compass,
  History,
  Layers3,
  RotateCcw,
  Settings,
  Trophy,
  Users,
} from 'lucide-react';

export type AppTab =
  | 'home'
  | 'training'
  | 'skill-tracks'
  | 'reviews'
  | 'contests'
  | 'journal'
  | 'topics'
  | 'history'
  | 'social'
  | 'settings';

interface AppNavigationProps {
  activeTab: AppTab;
  dueCount: number;
  onNavigate: (tab: AppTab) => void;
}

const sections: Array<{
  label: string;
  items: Array<{ key: AppTab; label: string; icon: typeof BarChart3 }>;
}> = [
  {
    label: 'Workspace',
    items: [
      { key: 'home', label: 'Overview', icon: BarChart3 },
      { key: 'training', label: "Today's training", icon: CalendarDays },
      { key: 'reviews', label: 'Spaced reviews', icon: RotateCcw },
    ],
  },
  {
    label: 'Improve',
    items: [
      { key: 'skill-tracks', label: 'Mastery map', icon: Compass },
      { key: 'topics', label: 'Topic analysis', icon: Layers3 },
      { key: 'journal', label: 'Knowledge journal', icon: BookOpen },
      { key: 'contests', label: 'Contests', icon: Trophy },
      { key: 'history', label: 'Training history', icon: History },
    ],
  },
  {
    label: 'Community',
    items: [{ key: 'social', label: 'Friends & blogs', icon: Users }],
  },
];

export const AppNavigation: React.FC<AppNavigationProps> = ({
  activeTab,
  dueCount,
  onNavigate,
}) => {
  const navButton = (key: AppTab, label: string, Icon: typeof BarChart3) => (
    <button
      key={key}
      type="button"
      onClick={() => onNavigate(key)}
      aria-current={activeTab === key ? 'page' : undefined}
      className={`group flex shrink-0 items-center gap-3 whitespace-nowrap rounded-xl px-3 py-2.5 text-left text-sm transition-colors lg:w-full ${
        activeTab === key
          ? 'bg-cyan-400/10 font-semibold text-cyan-100 ring-1 ring-inset ring-cyan-300/15'
          : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
      }`}
    >
      <Icon
        aria-hidden="true"
        className={`h-[18px] w-[18px] shrink-0 ${
          activeTab === key ? 'text-cyan-300' : 'text-slate-500 group-hover:text-slate-300'
        }`}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {key === 'reviews' && dueCount > 0 && (
        <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300">
          {dueCount}
        </span>
      )}
    </button>
  );

  return (
    <>
      <aside className="hidden w-60 shrink-0 border-r border-slate-800/80 bg-slate-950/45 px-4 py-6 lg:block">
        <nav aria-label="Main sections" className="sticky top-24 space-y-7">
          {sections.map((section) => (
            <div key={section.label}>
              <h2 className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-600">
                {section.label}
              </h2>
              <div className="space-y-1">
                {section.items.map(({ key, label, icon }) =>
                  navButton(key, label, icon),
                )}
              </div>
            </div>
          ))}
          <div className="border-t border-slate-800/70 pt-4">
            {navButton('settings', 'Settings', Settings)}
          </div>
        </nav>
      </aside>

      <nav
        aria-label="Main sections"
        className="border-b border-slate-800/80 bg-slate-950/70 px-3 py-2 lg:hidden"
      >
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {sections.flatMap((section) =>
            section.items.map(({ key, label, icon }) =>
              navButton(key, label, icon),
            ),
          )}
          {navButton('settings', 'Settings', Settings)}
        </div>
      </nav>
    </>
  );
};
