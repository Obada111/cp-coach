import React, { useState } from 'react';
import { 
  Calendar, 
  CheckCircle2, 
  ExternalLink, 
  Clock, 
  ChevronRight, 
  ChevronDown,
  BookOpen,
  HelpCircle,
  XCircle,
  FileText
} from 'lucide-react';
import { DailySet } from '../types';

interface HistoryViewProps {
  history: DailySet[];
}

export const HistoryView: React.FC<HistoryViewProps> = ({ history }) => {
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set([history[0]?.date]));

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  };

  if (!history || history.length === 0) {
    return (
      <div className="p-8 rounded-xl bg-slate-900/60 border border-slate-800 text-center">
        <Calendar className="w-8 h-8 text-slate-600 mx-auto mb-2" />
        <h3 className="text-sm font-semibold text-slate-300">No Previous Training Days Recorded</h3>
        <p className="text-xs text-slate-500 mt-1">
          Complete daily training assignments to build your historical practice log.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <Calendar className="w-4 h-4 text-purple-400" />
          Past Daily Training Sets & Learning Logs
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Review previous problems, solve approaches, time spent, and reflections.
        </p>
      </div>

      <div className="space-y-3">
        {history.map((set) => {
          const isExpanded = expandedDates.has(set.date);
          const { completed, total, percentage } = set.completionProgress;

          return (
            <div 
              key={set.date}
              className="rounded-xl border border-slate-800 bg-slate-900/80 overflow-hidden transition-all"
            >
              {/* Day Header Bar */}
              <div 
                onClick={() => toggleDate(set.date)}
                className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-850/60 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs font-semibold text-slate-200">
                    {set.date}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-white">
                        {completed} of {total} Problems Completed
                      </span>
                      {completed === total && total > 0 && (
                        <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-1.5 py-0.2 rounded">
                          100% Complete
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 font-mono">
                      Generated: {new Date(set.generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {/* Mini progress bar */}
                  <div className="w-24 sm:w-32 bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800 hidden sm:block">
                    <div 
                      className="bg-emerald-500 h-full rounded-full" 
                      style={{ width: `${percentage}%` }} 
                    />
                  </div>

                  <button className="text-slate-400 hover:text-white p-1">
                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Day Problems Content */}
              {isExpanded && (
                <div className="p-4 border-t border-slate-800 bg-slate-950/40 space-y-3">
                  {set.problems.map((prob) => {
                    const p = prob.problem;
                    const cfUrl = p ? `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` : '#';

                    return (
                      <div 
                        key={prob.id}
                        className="p-3.5 rounded-lg bg-slate-900 border border-slate-800 space-y-2 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-white">
                              {p?.contestId}{p?.index}. {p?.name}
                            </span>
                            {p?.rating && (
                              <span className="font-mono text-cyan-400 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 text-[10px]">
                                ★ {p.rating}
                              </span>
                            )}
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-850 text-slate-300 font-mono uppercase">
                              {prob.category.replace('_', ' ')}
                            </span>
                          </div>

                          <a
                            href={cfUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 text-[11px] text-cyan-400 hover:underline shrink-0"
                          >
                            <span>Open</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>

                        {/* Feedback Status */}
                        <div className="flex items-center gap-3 text-slate-400 text-[11px] pt-1">
                          <div className="flex items-center gap-1">
                            <span className="text-slate-500">Verdict:</span>
                            {prob.solvedStatus === 'SOLVED_INDEPENDENTLY' && (
                              <span className="text-emerald-400 font-medium flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Solved Independently
                              </span>
                            )}
                            {prob.solvedStatus === 'SOLVED_WITH_HINTS' && (
                              <span className="text-cyan-400 font-medium flex items-center gap-1">
                                <HelpCircle className="w-3 h-3" /> Solved With Hints
                              </span>
                            )}
                            {prob.solvedStatus === 'VIEWED_EDITORIAL' && (
                              <span className="text-amber-400 font-medium flex items-center gap-1">
                                <BookOpen className="w-3 h-3" /> Used Editorial
                              </span>
                            )}
                            {prob.solvedStatus === 'NOT_SOLVED' && (
                              <span className="text-rose-400 font-medium flex items-center gap-1">
                                <XCircle className="w-3 h-3" /> Not Solved
                              </span>
                            )}
                            {!prob.solvedStatus && (
                              <span className="text-slate-500 italic">No feedback recorded</span>
                            )}
                          </div>

                          {prob.perceivedDifficulty && (
                            <div>
                              <span className="text-slate-500">Difficulty: </span>
                              <span className="text-slate-200 font-semibold">{prob.perceivedDifficulty}</span>
                            </div>
                          )}

                          {prob.timeSpentMinutes ? (
                            <div className="flex items-center gap-1">
                              <Clock className="w-3 h-3 text-slate-500" />
                              <span className="font-mono text-slate-200">{prob.timeSpentMinutes} mins</span>
                            </div>
                          ) : null}
                        </div>

                        {/* Personal Notes */}
                        {prob.notes && (
                          <div className="p-2.5 rounded bg-slate-950 border border-slate-850 text-slate-300 text-[11px] flex items-start gap-2">
                            <FileText className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                            <p className="italic">"{prob.notes}"</p>
                          </div>
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
    </div>
  );
};
