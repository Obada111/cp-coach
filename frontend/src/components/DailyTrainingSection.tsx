import React from 'react';
import { Calendar, CheckCircle2, Clock, Sparkles } from 'lucide-react';
import { DailySet, FeedbackPayload } from '../types';
import { DailyProblemCard } from './DailyProblemCard';

interface DailyTrainingSectionProps {
  dailySet: DailySet | null;
  onSaveFeedback: (problemId: string, payload: FeedbackPayload) => Promise<void>;
  isLoading: boolean;
}

export const DailyTrainingSection: React.FC<DailyTrainingSectionProps> = ({
  dailySet,
  onSaveFeedback,
  isLoading,
}) => {
  if (isLoading) {
    return (
      <div className="p-8 rounded-xl bg-slate-900/60 border border-slate-800 text-center animate-pulse">
        <Sparkles className="w-8 h-8 text-cyan-500 mx-auto mb-2 animate-spin" />
        <p className="text-sm font-semibold text-slate-300">Generating Today's Personalized CP Training Set...</p>
        <p className="text-xs text-slate-500 mt-1">
          Evaluating Codeforces rating, tag performances, and recent feedback for Asia/Hebron local day.
        </p>
      </div>
    );
  }

  if (!dailySet || dailySet.problems.length === 0) {
    return (
      <div className="p-8 rounded-xl bg-slate-900/60 border border-slate-800 text-center">
        <Calendar className="w-8 h-8 text-slate-600 mx-auto mb-2" />
        <h3 className="text-sm font-semibold text-slate-300">No Problem Set Available for Today</h3>
        <p className="text-xs text-slate-500 mt-1">
          Ensure Codeforces problems are synchronized or click "Sync CF" in the header to populate candidate problems.
        </p>
      </div>
    );
  }

  const { completed, total, percentage } = dailySet.completionProgress;

  return (
    <div className="space-y-6">
      {/* Daily Progress Header */}
      <div className="p-5 rounded-xl bg-gradient-to-r from-slate-900 via-slate-900/95 to-slate-850 border border-slate-800 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-mono font-medium text-cyan-400 bg-cyan-950/60 border border-cyan-800/50 px-2 py-0.5 rounded">
                <Clock className="w-3.5 h-3.5" />
                {dailySet.date} (Asia/Hebron)
              </span>
              <span className="text-xs text-slate-400 font-medium">Daily Regimen</span>
            </div>
            <h2 className="text-lg font-bold text-white mt-1 flex items-center gap-2">
              Today's 3 Targeted Problems
            </h2>
            <p className="text-xs text-slate-400">
              Balanced drill designed to target demonstrated weaknesses, reinforce core concepts, and stretch contest limits.
            </p>
          </div>

          {/* Progress Bar & Counter */}
          <div className="min-w-[180px] sm:text-right">
            <div className="flex items-center justify-between sm:justify-end gap-2 text-xs mb-1.5">
              <span className="text-slate-400">Progress:</span>
              <span className="font-bold text-white flex items-center gap-1">
                {completed} of {total} Done
                {completed === total && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
              </span>
            </div>
            <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800">
              <div 
                className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full rounded-full transition-all duration-500"
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 3 Problem Cards Grid */}
      <div className="grid grid-cols-1 gap-4">
        {dailySet.problems.map((item) => (
          <DailyProblemCard 
            key={item.id} 
            problemItem={item} 
            onSaveFeedback={onSaveFeedback} 
          />
        ))}
      </div>
    </div>
  );
};
