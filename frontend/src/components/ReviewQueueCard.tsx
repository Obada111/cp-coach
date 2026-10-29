import React, { useState } from 'react';
import { 
  RotateCcw, 
  ExternalLink, 
  CheckCircle2, 
  Clock, 
  Play,
  Check
} from 'lucide-react';
import { ReviewQueueItem, ReviewQueueSummary } from '../types';
import { actionReview } from '../api';

interface ReviewQueueCardProps {
  dueReviews: ReviewQueueItem[];
  summary?: ReviewQueueSummary | { dueCount: number; upcomingCount: number; masteredCount: number; totalCount: number };
  profileId: string;
  onReviewUpdated: () => void;
  onStartSession?: (problemId: string) => void;
}

export const ReviewQueueCard: React.FC<ReviewQueueCardProps> = ({
  dueReviews,
  summary,
  profileId,
  onReviewUpdated,
  onStartSession,
}) => {
  const [actingId, setActingId] = useState<string | null>(null);

  const handleAction = async (problemId: string, outcome: 'MASTERED' | 'EASY' | 'DIFFICULT' | 'DEFERRED') => {
    setActingId(problemId);
    try {
      await actionReview(problemId, outcome, undefined, profileId);
      onReviewUpdated();
    } catch (err) {
      console.error('Failed to submit review outcome:', err);
    } finally {
      setActingId(null);
    }
  };

  const dueCount = summary ? ('dueCount' in summary ? summary.dueCount : summary.dueTodayCount) : dueReviews.length;
  const masteredCount = summary ? summary.masteredCount : 0;
  const upcomingCount = summary ? ('upcomingCount' in summary ? summary.upcomingCount : 0) : 0;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <RotateCcw className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              Spaced Repetition Review
              {dueCount > 0 && (
                <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  {dueCount} Due Today
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-400">
              Adaptive memory retention loop (1d → 3d → 7d → 14d → Mastered)
            </p>
          </div>
        </div>

        {/* Counter Pills */}
        <div className="flex items-center gap-2 text-xs">
          <div className="px-3 py-1 rounded-lg bg-slate-800/80 border border-slate-700/60 text-slate-300">
            <span className="text-emerald-400 font-bold mr-1">{masteredCount}</span> Mastered
          </div>
          <div className="px-3 py-1 rounded-lg bg-slate-800/80 border border-slate-700/60 text-slate-300">
            <span className="text-indigo-400 font-bold mr-1">{upcomingCount}</span> Upcoming
          </div>
        </div>
      </div>

      {/* Due Reviews List */}
      {dueReviews.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-8 rounded-xl bg-slate-800/30 border border-dashed border-slate-800 text-center">
          <div className="p-3 rounded-full bg-emerald-500/10 text-emerald-400 mb-3">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h4 className="text-sm font-semibold text-white mb-1">Queue Clear for Today!</h4>
          <p className="text-xs text-slate-400 max-w-sm">
            All struggling problems have been consolidated or scheduled for future review windows.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {dueReviews.map((item) => {
            const isProcessing = actingId === item.problemId;
            return (
              <div
                key={item.id}
                className="p-4 rounded-xl bg-slate-800/50 hover:bg-slate-800/80 border border-slate-700/60 transition flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                {/* Problem Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className="px-2 py-0.5 text-xs font-semibold rounded bg-amber-950/60 text-amber-300 border border-amber-800/60">
                      Repetition #{item.repetitionCount}
                    </span>
                    {item.rating && (
                      <span className="px-2 py-0.5 text-xs font-mono font-bold rounded bg-slate-700 text-amber-300">
                        ★ {item.rating}
                      </span>
                    )}
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Interval: {item.intervalDays}d
                    </span>
                  </div>

                  <h4 className="text-sm font-bold text-white flex items-center gap-2 truncate">
                    <span>{item.problemName}</span>
                    <a
                      href={item.cfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-400 hover:text-indigo-300 transition"
                      title="Open on Codeforces"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </h4>

                  <p className="text-xs text-slate-400 mt-1 line-clamp-1">
                    <span className="text-slate-300 font-medium">Trigger:</span> {item.triggerReason}
                  </p>
                </div>

                {/* Adaptive Action Buttons */}
                <div className="flex flex-wrap items-center gap-2 self-start md:self-center">
                  {onStartSession && (
                    <button
                      onClick={() => onStartSession(item.problemId)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition shadow-sm"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      Practice
                    </button>
                  )}

                  <button
                    disabled={isProcessing}
                    onClick={() => handleAction(item.problemId, 'EASY')}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/60 transition disabled:opacity-50"
                    title="Solid solve. Advance interval (e.g. +3d or +7d)"
                  >
                    Comfortable (+adv)
                  </button>

                  <button
                    disabled={isProcessing}
                    onClick={() => handleAction(item.problemId, 'DIFFICULT')}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-amber-950/60 hover:bg-amber-900/80 text-amber-300 border border-amber-800/60 transition disabled:opacity-50"
                    title="Still shaky. Keep short interval (+1d)"
                  >
                    Struggled (+1d)
                  </button>

                  <button
                    disabled={isProcessing}
                    onClick={() => handleAction(item.problemId, 'MASTERED')}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-purple-950/60 hover:bg-purple-900/80 text-purple-300 border border-purple-800/60 transition disabled:opacity-50 flex items-center gap-1"
                    title="Fully mastered pattern"
                  >
                    <Check className="w-3 h-3" />
                    Mastered
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
