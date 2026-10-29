import React from 'react';
import { TopicAnalysis } from '../types';
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';

interface Props {
  topics: {
    weak: TopicAnalysis[];
    strong: TopicAnalysis[];
    unexplored: TopicAnalysis[];
    all: TopicAnalysis[];
  };
  compact?: boolean;
}

export const TopicList: React.FC<Props> = ({ topics, compact }) => {
  const displayed = compact ? topics.all.slice(0, 8) : topics.all;

  if (displayed.length === 0) {
    return (
      <p className="text-xs text-slate-500 py-4 text-center">
        Sync your Codeforces data to see topic analysis.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!compact && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
            <div className="text-lg font-bold text-rose-400">{topics.weak.length}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">Weak</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
            <div className="text-lg font-bold text-emerald-400">{topics.strong.length}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">Strong</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
            <div className="text-lg font-bold text-slate-400">{topics.unexplored.length}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">Unexplored</div>
          </div>
        </div>
      )}

      {displayed.map((t) => {
        const Icon = t.status === 'WEAK' ? AlertTriangle : t.status === 'STRONG' ? CheckCircle2 : HelpCircle;
        const color = t.status === 'WEAK' ? 'text-rose-400' : t.status === 'STRONG' ? 'text-emerald-400' : 'text-slate-500';
        const barColor = t.status === 'WEAK' ? 'bg-rose-500' : t.status === 'STRONG' ? 'bg-emerald-500' : 'bg-slate-600';

        return (
          <div key={t.tag} className="p-3 rounded-lg bg-slate-900/60 border border-slate-800/60 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon className={`w-3.5 h-3.5 ${color}`} />
                <span className="text-sm font-semibold text-white capitalize">{t.tag}</span>
              </div>
              <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
                <span>{t.solvedCount}/{t.attemptsCount}</span>
                <span className={`font-semibold ${t.weaknessScore >= 50 ? 'text-rose-400' : t.weaknessScore >= 30 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {t.weaknessScore}
                </span>
              </div>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-slate-950 rounded-full h-1 overflow-hidden">
              <div className={`${barColor} h-full rounded-full`} style={{ width: `${t.solveRate}%` }} />
            </div>

            {!compact && (
              <p className="text-[11px] text-slate-500 leading-relaxed">{t.explanation}</p>
            )}
          </div>
        );
      })}
    </div>
  );
};
