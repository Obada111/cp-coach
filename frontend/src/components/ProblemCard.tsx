import React, { useState } from 'react';
import { 
  ExternalLink, CheckCircle2, HelpCircle, BookOpen, XCircle, 
  Save, ChevronDown, ChevronUp, GraduationCap, AlertTriangle, Lightbulb, Loader2,
  Play, RotateCw, RotateCcw, Check
} from 'lucide-react';
import { DailyProblem, FeedbackPayload, ProblemSolvedStatus, PerceivedDifficulty, ProblemTutorial } from '../types';
import { TutorialModal } from './TutorialModal';
import { fetchProblemTutorial } from '../api';

interface Props {
  item: DailyProblem;
  onSaveFeedback: (id: string, payload: FeedbackPayload) => Promise<void>;
  onOpenProblem?: (id: string) => Promise<void>;
  onStartSession?: (item: DailyProblem) => void;
  onReplaceProblem?: (dailyProblemId: string) => Promise<void>;
  onSendToReview?: (problemId: string) => Promise<void>;
}

const categoryMeta = {
  WEAKNESS_DRILL: { label: 'Weakness Drill', accent: 'text-rose-400', dot: 'bg-rose-400', border: 'border-rose-500/30' },
  REINFORCEMENT: { label: 'Reinforcement', accent: 'text-amber-400', dot: 'bg-amber-400', border: 'border-amber-500/30' },
  CHALLENGE: { label: 'Challenge', accent: 'text-violet-400', dot: 'bg-violet-400', border: 'border-violet-500/30' },
} as const;

const sourceLabels: Record<string, { label: string; color: string; border: string }> = {
  CODEFORCES_EDU: { label: 'Codeforces EDU', color: 'text-cyan-300 bg-cyan-950/60', border: 'border-cyan-700/50' },
  CODEFORCES_PROBLEMSET: { label: 'Codeforces', color: 'text-blue-300 bg-blue-950/60', border: 'border-blue-700/50' },
};

export const ProblemCard: React.FC<Props> = ({ 
  item, 
  onSaveFeedback, 
  onOpenProblem, 
  onStartSession, 
  onReplaceProblem, 
  onSendToReview 
}) => {
  const p = item.problem;
  const cfUrl = item.educationalSourceUrl || (p && p.contestId > 0 && p.contestId < 100000 && p.contestId !== 99999 ? `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` : '#');
  const meta = categoryMeta[item.category] || categoryMeta.WEAKNESS_DRILL;
  const sourceBadge = item.educationalSource ? sourceLabels[item.educationalSource] || sourceLabels.CODEFORCES_PROBLEMSET : null;

  const [expanded, setExpanded] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialData, setTutorialData] = useState<ProblemTutorial | null>(item.tutorial || null);
  const [loadingTutorial, setLoadingTutorial] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [enqueued, setEnqueued] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);

  const [solvedStatus, setSolvedStatus] = useState<ProblemSolvedStatus>(item.solvedStatus || 'NOT_SOLVED');
  const [difficulty, setDifficulty] = useState<PerceivedDifficulty | null>(item.perceivedDifficulty || null);
  const [struggleReason, setStruggleReason] = useState<string>(item.struggleReason || '');
  const [time, setTime] = useState<number | ''>(item.timeSpentMinutes ?? '');
  const [notes, setNotes] = useState(item.notes || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const isDone = item.verifiedCfAc || item.selfReportedSolved || (item.solvedStatus && item.solvedStatus !== 'NOT_SOLVED');

  const handleOpenTutorial = async () => {
    if (tutorialData) {
      setShowTutorial(true);
      return;
    }
    setLoadingTutorial(true);
    try {
      const data = await fetchProblemTutorial(item.problemId);
      setTutorialData(data);
      setShowTutorial(true);
    } catch (e) {
      console.error('Failed to load tutorial:', e);
    } finally {
      setLoadingTutorial(false);
    }
  };

  const handleLinkClick = () => {
    if (onOpenProblem) {
      onOpenProblem(item.id).catch(() => {});
    }
  };

  const handleReplace = async () => {
    if (!onReplaceProblem || replacing) return;
    setReplacing(true);
    try {
      await onReplaceProblem(item.id);
    } catch (e) {
      console.error('Failed to replace problem:', e);
    } finally {
      setReplacing(false);
    }
  };

  const handleSendToReview = async () => {
    if (!onSendToReview || enqueuing || enqueued) return;
    setEnqueuing(true);
    try {
      await onSendToReview(item.problemId);
      setEnqueued(true);
    } catch (e) {
      console.error('Failed to enqueue review:', e);
    } finally {
      setEnqueuing(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await onSaveFeedback(item.id, {
        solvedStatus,
        perceivedDifficulty: difficulty,
        timeSpentMinutes: time === '' ? null : Number(time),
        notes: notes.trim() || null,
        struggleReason: struggleReason || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`rounded-xl border transition-all ${isDone ? 'border-slate-700/80 bg-slate-900/60' : `${meta.border} bg-slate-900/80`}`}>
      <div className="p-4 sm:p-5">
        {/* Top Row: category + source + rating + status + external link */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.accent}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
            </span>

            {sourceBadge && (
              <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${sourceBadge.color} ${sourceBadge.border}`}>
                <GraduationCap className="w-3 h-3" />
                {sourceBadge.label}
              </span>
            )}

            {p?.rating && (
              <span className="text-xs font-mono text-cyan-400/80 bg-cyan-950/40 px-2 py-0.5 rounded-md border border-cyan-900/40">
                ★ {p.rating}
              </span>
            )}

            {/* Clear, distinct status indicators */}
            {item.verifiedCfAc ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-cyan-300 font-medium bg-cyan-950/70 border border-cyan-800/50 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3 text-cyan-400" /> Verified CF AC
              </span>
            ) : (item.selfReportedSolved || (item.solvedStatus && item.solvedStatus !== 'NOT_SOLVED')) ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-300 font-medium bg-amber-950/50 border border-amber-800/50 px-2 py-0.5 rounded-full" title="Self-reported completion (not verified on Codeforces)">
                <BookOpen className="w-3 h-3 text-amber-400" /> Self-Reported
              </span>
            ) : item.attempted ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-orange-300 font-medium bg-orange-950/50 border border-orange-800/50 px-2 py-0.5 rounded-full">
                <AlertTriangle className="w-3 h-3 text-orange-400" /> Attempted · No AC
              </span>
            ) : item.isOpened ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-blue-300 font-medium bg-blue-950/50 border border-blue-800/50 px-2 py-0.5 rounded-full">
                <ExternalLink className="w-3 h-3 text-blue-400" /> Opened
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 font-medium bg-slate-950/50 border border-slate-800/50 px-2 py-0.5 rounded-full">
                Not Opened
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {onStartSession && (
              <button
                type="button"
                onClick={() => onStartSession(item)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-700/60 text-emerald-300 hover:text-emerald-100 text-xs font-semibold shadow-sm transition-all"
                title="Start a live focused solve session with timer and post-solve reflection"
              >
                <Play className="w-3 h-3 fill-current text-emerald-400" />
                <span>Session</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleOpenTutorial}
              disabled={loadingTutorial}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-950/70 hover:bg-cyan-900 border border-cyan-700/60 text-cyan-300 hover:text-cyan-100 text-xs font-semibold shadow-sm transition-all"
              title="Open progressive hints and masterclass tutorial"
            >
              {loadingTutorial ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              ) : (
                <Lightbulb className="w-3.5 h-3.5 text-cyan-400" />
              )}
              <span>Hints</span>
            </button>

            {onReplaceProblem && (
              <button
                type="button"
                disabled={replacing}
                onClick={handleReplace}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-750 border border-slate-700 text-slate-300 hover:text-white text-xs font-medium transition-all disabled:opacity-50"
                title="Replace with another eligible problem preferring recent official rounds"
              >
                <RotateCw className={`w-3 h-3 ${replacing ? 'animate-spin text-cyan-400' : ''}`} />
                <span>{replacing ? '...' : 'Reroll'}</span>
              </button>
            )}

            {onSendToReview && (
              <button
                type="button"
                disabled={enqueuing || enqueued}
                onClick={handleSendToReview}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-medium transition-all ${
                  enqueued 
                    ? 'bg-purple-950/70 border-purple-700 text-purple-300' 
                    : 'bg-slate-800/80 hover:bg-slate-700 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                title="Add problem to Spaced Repetition queue"
              >
                {enqueued ? <Check className="w-3 h-3 text-purple-400" /> : <RotateCcw className="w-3 h-3" />}
                <span>{enqueued ? 'Saved' : 'Review'}</span>
              </button>
            )}

            <a
              href={cfUrl}
              target="_blank"
              rel="noreferrer"
              onClick={handleLinkClick}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-cyan-300 font-medium transition-colors ml-1"
            >
              {item.educationalSource === 'CODEFORCES_EDU' ? 'CF EDU' : 'Codeforces'}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Problem name */}
        <h3 className="text-base font-bold text-white mt-2.5 leading-snug">
          <a href={cfUrl} target="_blank" rel="noreferrer" onClick={handleLinkClick} className="hover:text-cyan-300 transition-colors">
            {p?.contestId && p.contestId > 0 && p.contestId < 100000 ? `${p.contestId}${p.index}. ` : ''}{p?.name || 'Assigned Problem'}
          </a>
        </h3>

        {/* Tags */}
        {p?.tags && p.tags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2">
            {p.tags.map((t) => (
              <span key={t} className="text-[11px] text-slate-500 bg-slate-800/80 px-1.5 py-0.5 rounded font-mono">{t}</span>
            ))}
          </div>
        )}

        {/* Learning Objective if verified educational source */}
        {item.learningObjective && (
          <div className="mt-3 p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs text-slate-300 flex items-start gap-2">
            <GraduationCap className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-200">
                {item.curriculumStage ? `${item.curriculumStage}: ` : 'Learning Objective: '}
              </span>
              <span className="text-slate-400">{item.learningObjective}</span>
            </div>
          </div>
        )}

        {/* Personalized Rationale */}
        <p className="mt-3 text-xs text-slate-400 leading-relaxed">{item.reason}</p>

        {/* Existing feedback summary OR expand toggle */}
        <div className="mt-3 pt-3 border-t border-slate-800/60 flex items-center justify-between">
          {item.solvedStatus && item.solvedStatus !== 'NOT_SOLVED' ? (
            <div className="flex items-center gap-3 text-xs text-slate-400 flex-wrap">
              <span className="text-emerald-400 font-medium">
                {item.solvedStatus === 'SOLVED_INDEPENDENTLY' && '✓ Solved independently'}
                {item.solvedStatus === 'SOLVED_WITH_HINTS' && '✓ Used hints'}
                {item.solvedStatus === 'VIEWED_EDITORIAL' && '✓ Used editorial'}
              </span>
              {item.perceivedDifficulty && <span>· {item.perceivedDifficulty}</span>}
              {item.timeSpentMinutes && <span>· {item.timeSpentMinutes}m</span>}
              {item.struggleReason && (
                <span className="text-amber-400 text-[11px] flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Roadblock: {item.struggleReason.replace(/_/g, ' ').toLowerCase()}
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-slate-600">No feedback yet</span>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-white px-2 py-1 rounded-lg hover:bg-slate-800 transition-all"
          >
            {expanded ? 'Hide' : 'Log feedback'}
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Feedback form */}
      {expanded && (
        <form onSubmit={handleSave} className="px-4 sm:px-5 pb-5 space-y-4 border-t border-slate-800/40 pt-4">
          {/* Solve status */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-2">How did it go?</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {([
                { v: 'SOLVED_INDEPENDENTLY' as const, icon: CheckCircle2, label: 'Solo', active: 'bg-emerald-950/60 border-emerald-500/60 text-emerald-300' },
                { v: 'SOLVED_WITH_HINTS' as const, icon: HelpCircle, label: 'Hints', active: 'bg-cyan-950/60 border-cyan-500/60 text-cyan-300' },
                { v: 'VIEWED_EDITORIAL' as const, icon: BookOpen, label: 'Editorial', active: 'bg-amber-950/60 border-amber-500/60 text-amber-300' },
                { v: 'NOT_SOLVED' as const, icon: XCircle, label: 'Unsolved', active: 'bg-rose-950/60 border-rose-500/60 text-rose-300' },
              ] as const).map((opt) => {
                const isActive = solvedStatus === opt.v;
                return (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setSolvedStatus(opt.v)}
                    className={`flex items-center justify-center gap-1.5 p-2.5 rounded-lg text-xs font-medium border transition-all ${
                      isActive
                        ? opt.active
                        : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <opt.icon className="w-3.5 h-3.5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Difficulty + Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2">Difficulty</label>
              <div className="flex gap-1.5">
                {(['EASY', 'NORMAL', 'HARD'] as PerceivedDifficulty[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDifficulty(d)}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-all ${
                      difficulty === d
                        ? d === 'EASY' ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-300'
                        : d === 'NORMAL' ? 'bg-blue-950/60 border-blue-500/60 text-blue-300'
                        : 'bg-rose-950/60 border-rose-500/60 text-rose-300'
                        : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2">Time (min)</label>
              <input
                type="number"
                min="1"
                max="480"
                placeholder="e.g. 30"
                value={time}
                onChange={(e) => setTime(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500/60"
              />
            </div>
          </div>

          {/* Optional Roadblock Selector if Hard or Not Solved */}
          {(difficulty === 'HARD' || solvedStatus === 'NOT_SOLVED' || solvedStatus === 'VIEWED_EDITORIAL') && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2">
                What was the main roadblock? (helps the coach adapt tomorrow)
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { id: 'ALGORITHM_RECOGNITION', label: 'Algorithm Idea' },
                  { id: 'IMPLEMENTATION_DIFFICULTY', label: 'Implementation' },
                  { id: 'EDGE_CASES', label: 'Edge Cases' },
                  { id: 'TIME_COMPLEXITY', label: 'Complexity / TLE' },
                ].map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setStruggleReason(struggleReason === r.id ? '' : r.id)}
                    className={`py-1.5 px-2 rounded-lg text-[11px] font-medium border transition-all text-center ${
                      struggleReason === r.id
                        ? 'bg-amber-950/60 border-amber-500 text-amber-200'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-300'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-2">Notes & Reflection (optional)</label>
            <textarea
              rows={2}
              placeholder="What core invariant or edge case did you take away?..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500/60 resize-none"
            />
          </div>

          {/* Save */}
          <div className="flex items-center justify-end gap-2">
            {saved && <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Saved</span>}
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-all disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {/* Progressive Hints & Masterclass Tutorial Modal */}
      <TutorialModal
        tutorial={tutorialData}
        isOpen={showTutorial}
        onClose={() => setShowTutorial(false)}
      />
    </div>
  );
};
