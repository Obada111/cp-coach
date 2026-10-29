import React from 'react';
import { Calendar, ExternalLink, ChevronRight } from 'lucide-react';
import { DailySet } from '../types';

interface Props {
  history: DailySet[];
}

export const HistoryList: React.FC<Props> = ({ history }) => {
  const [expandedDate, setExpandedDate] = React.useState<string | null>(null);

  if (!history || history.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-slate-500">
        <Calendar className="w-6 h-6 mx-auto mb-2 text-slate-600" />
        No training history yet. Complete today's problems to start tracking.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {history.map((set) => {
        const open = expandedDate === set.date;
        const { completed, total } = set.completionProgress;

        return (
          <div key={set.date} className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
            <button
              onClick={() => setExpandedDate(open ? null : set.date)}
              className="w-full p-3.5 flex items-center justify-between text-left hover:bg-slate-800/40 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono font-semibold text-slate-300 bg-slate-800 px-2 py-1 rounded-md">{set.date}</span>
                <span className="text-xs text-slate-400">{completed}/{total} done</span>
                {completed === total && total > 0 && (
                  <span className="text-[10px] text-emerald-400 font-semibold">✓ Complete</span>
                )}
              </div>
              <ChevronRight className={`w-4 h-4 text-slate-600 transition-transform ${open ? 'rotate-90' : ''}`} />
            </button>

            {open && (
              <div className="px-3.5 pb-3.5 space-y-2 border-t border-slate-800/60">
                {set.problems.map((prob) => {
                  const p = prob.problem;
                  const cfUrl = p ? `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` : '#';

                  return (
                    <div key={prob.id} className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/40 text-xs space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-white">{p?.contestId}{p?.index}. {p?.name}</span>
                          {p?.rating && (
                            <span className="text-cyan-400 font-mono text-[11px]">{p.rating}</span>
                          )}
                        </div>
                        <a href={cfUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:text-cyan-300 shrink-0">
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>

                      <div className="flex items-center gap-3 text-slate-500 text-[11px] flex-wrap">
                        <span className="uppercase text-slate-600 font-mono">{prob.category.replace('_', ' ')}</span>
                        {prob.solvedStatus && (
                          <span className={
                            prob.solvedStatus === 'SOLVED_INDEPENDENTLY' ? 'text-emerald-400' :
                            prob.solvedStatus === 'SOLVED_WITH_HINTS' ? 'text-cyan-400' :
                            prob.solvedStatus === 'VIEWED_EDITORIAL' ? 'text-amber-400' : 'text-rose-400'
                          }>
                            {prob.solvedStatus === 'SOLVED_INDEPENDENTLY' && '✓ Solo'}
                            {prob.solvedStatus === 'SOLVED_WITH_HINTS' && '✓ Hints'}
                            {prob.solvedStatus === 'VIEWED_EDITORIAL' && '✓ Editorial'}
                            {prob.solvedStatus === 'NOT_SOLVED' && '✗ Unsolved'}
                          </span>
                        )}
                        {prob.perceivedDifficulty && <span>· {prob.perceivedDifficulty}</span>}
                        {prob.timeSpentMinutes && <span>· {prob.timeSpentMinutes}m</span>}
                      </div>

                      {prob.notes && (
                        <p className="text-slate-500 italic text-[11px] pt-1 border-t border-slate-800/40">
                          "{prob.notes}"
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
