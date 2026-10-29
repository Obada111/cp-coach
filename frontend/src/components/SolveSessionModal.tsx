import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Play, 
  Pause, 
  RotateCcw, 
  BookOpen, 
  CheckCircle2, 
  AlertTriangle, 
  ExternalLink, 
  Clock, 
  Lightbulb,
  ArrowRight,
  Brain,
  Sparkles
} from 'lucide-react';
import { SolveSession, DailyProblem } from '../types';
import { 
  startSolveSession, 
  recordSessionHint, 
  recordSessionEditorial, 
  finishSolveSession 
} from '../api';

interface SolveSessionModalProps {
  problem: DailyProblem;
  profileId: string;
  isOpen: boolean;
  onClose: () => void;
  onSessionFinished: (session: SolveSession) => void;
  onOpenTutorial: () => void;
}

export const SolveSessionModal: React.FC<SolveSessionModalProps> = ({
  problem,
  profileId,
  isOpen,
  onClose,
  onSessionFinished,
  onOpenTutorial,
}) => {
  const [session, setSession] = useState<SolveSession | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(true);
  const [hintsRevealed, setHintsRevealed] = useState(0);
  const [editorialViewed, setEditorialViewed] = useState(false);
  const [showReflection, setShowReflection] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reflection form state
  const [outcome, setOutcome] = useState<'SOLVED_INDEPENDENTLY' | 'SOLVED_WITH_HINTS' | 'SOLVED_WITH_EDITORIAL' | 'UNSOLVED' | 'ABANDONED'>('SOLVED_INDEPENDENTLY');
  const [perceivedDifficulty, setPerceivedDifficulty] = useState<'EASY' | 'NORMAL' | 'HARD'>('NORMAL');
  const [struggleType, setStruggleType] = useState<string>('NONE');
  const [keyTakeaway, setKeyTakeaway] = useState<string>('');
  const [reflectionNotes, setReflectionNotes] = useState<string>('');

  const timerRef = useRef<any>(null);

  // Initialize or start session when opened
  useEffect(() => {
    if (isOpen) {
      setSeconds(0);
      setIsRunning(true);
      setShowReflection(false);
      setError(null);
      setHintsRevealed(0);
      setEditorialViewed(false);

      startSolveSession(problem.problemId, profileId)
        .then((res) => {
          if (res.session) {
            setSession(res.session);
          }
        })
        .catch((err) => {
          console.error('Could not initialize session:', err);
          setError(err.message || 'Failed to start session');
        });
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isOpen, problem.problemId, profileId]);

  // Timer interval
  useEffect(() => {
    if (isRunning && isOpen && !showReflection) {
      timerRef.current = setInterval(() => {
        setSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning, isOpen, showReflection]);

  if (!isOpen) return null;

  const formatTimer = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const handleRevealHint = async () => {
    if (!session) return;
    setHintsRevealed((h) => h + 1);
    try {
      await recordSessionHint(session.id);
      if (outcome === 'SOLVED_INDEPENDENTLY') {
        setOutcome('SOLVED_WITH_HINTS');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleViewEditorial = async () => {
    if (!session) return;
    setEditorialViewed(true);
    setOutcome('SOLVED_WITH_EDITORIAL');
    try {
      await recordSessionEditorial(session.id);
    } catch (err) {
      console.error(err);
    }
    onOpenTutorial();
  };

  const handleFinishSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await finishSolveSession(session.id, {
        outcome,
        activeDurationSeconds: seconds,
        perceivedDifficulty,
        struggleType,
        keyTakeaway: keyTakeaway.trim() || undefined,
        reflectionNotes: reflectionNotes.trim() || undefined,
      });

      if (res.session) {
        onSessionFinished(res.session);
        onClose();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save session');
    } finally {
      setIsSubmitting(false);
    }
  };

  const cfUrl = problem.problem?.contestId 
    ? `https://codeforces.com/problemset/problem/${problem.problem.contestId}/${problem.problem.index}`
    : problem.educationalSourceUrl || '#';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-3">
            <span className="flex h-3 w-3 relative">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isRunning ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${isRunning ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            </span>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Clock className="w-5 h-5 text-indigo-400" />
              Live Solve Session
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Problem Banner */}
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="px-2 py-0.5 text-xs font-semibold rounded bg-indigo-950/80 text-indigo-300 border border-indigo-800/60">
                  {problem.category.replace('_', ' ')}
                </span>
                {problem.problem?.rating && (
                  <span className="px-2 py-0.5 text-xs font-mono font-bold rounded bg-slate-700 text-amber-300">
                    ★ {problem.problem.rating}
                  </span>
                )}
              </div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                {problem.problem?.name || problem.problemId}
                <a
                  href={cfUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 transition"
                  title="Open Problem in Codeforces"
                >
                  <ExternalLink className="w-4 h-4 inline" />
                </a>
              </h3>
            </div>
            <a
              href={cfUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition self-start sm:self-center"
            >
              Open on Codeforces
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {!showReflection ? (
            /* ACTIVE TIMER VIEW */
            <div className="space-y-6">
              {/* Giant Digital Stopwatch */}
              <div className="flex flex-col items-center justify-center p-8 rounded-2xl bg-gradient-to-b from-slate-800/80 to-slate-900/90 border border-slate-700/60 shadow-inner">
                <div className="font-mono text-6xl sm:text-7xl font-extrabold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-teal-200 to-indigo-300 mb-6 drop-shadow-sm">
                  {formatTimer(seconds)}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsRunning(!isRunning)}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition shadow-lg ${
                      isRunning 
                        ? 'bg-amber-600/90 hover:bg-amber-500 text-white' 
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    }`}
                  >
                    {isRunning ? <><Pause className="w-4 h-4" /> Pause Timer</> : <><Play className="w-4 h-4" /> Resume Timer</>}
                  </button>
                  <button
                    onClick={() => setSeconds(0)}
                    className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                    title="Reset Timer"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Assistance & Guardrails */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={handleRevealHint}
                  className="flex items-center justify-between p-3.5 rounded-xl bg-slate-800/50 hover:bg-slate-800 border border-slate-700/60 text-left transition"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
                      <Lightbulb className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white">Reveal Progressive Hint</div>
                      <div className="text-xs text-slate-400">Recorded: {hintsRevealed} hint(s)</div>
                    </div>
                  </div>
                  <span className="text-xs font-mono px-2 py-1 rounded bg-slate-700 text-amber-300">+1 Hint</span>
                </button>

                <button
                  type="button"
                  onClick={handleViewEditorial}
                  className="flex items-center justify-between p-3.5 rounded-xl bg-slate-800/50 hover:bg-slate-800 border border-slate-700/60 text-left transition"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
                      <BookOpen className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white">Masterclass Tutorial</div>
                      <div className="text-xs text-slate-400">
                        {editorialViewed ? 'Editorial Viewed' : 'Unlocks Spaced Repetition'}
                      </div>
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-slate-400" />
                </button>
              </div>

              {/* Ready to finish */}
              <div className="pt-2">
                <button
                  onClick={() => {
                    setIsRunning(false);
                    setShowReflection(true);
                  }}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-sm transition shadow-lg shadow-emerald-950/40"
                >
                  Finish Session & Reflect
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            /* POST-SOLVE REFLECTION VIEW */
            <form onSubmit={handleFinishSubmit} className="space-y-5 animate-fade-in">
              <div className="bg-indigo-950/40 border border-indigo-800/50 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Brain className="w-6 h-6 text-indigo-400" />
                  <div>
                    <h4 className="text-sm font-bold text-white">Post-Solve Metacognitive Reflection</h4>
                    <p className="text-xs text-slate-400">Duration: {formatTimer(seconds)} • Record takeaways to encode patterns.</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowReflection(false)}
                  className="text-xs text-indigo-300 hover:underline"
                >
                  Back to Timer
                </button>
              </div>

              {/* Outcome Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Solve Outcome
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[
                    { id: 'SOLVED_INDEPENDENTLY', label: 'Solved Independently', color: 'border-emerald-500/60 bg-emerald-950/40 text-emerald-300' },
                    { id: 'SOLVED_WITH_HINTS', label: 'Solved with Hints', color: 'border-amber-500/60 bg-amber-950/40 text-amber-300' },
                    { id: 'SOLVED_WITH_EDITORIAL', label: 'Viewed Editorial', color: 'border-purple-500/60 bg-purple-950/40 text-purple-300' },
                    { id: 'UNSOLVED', label: 'Unsolved / Need Help', color: 'border-rose-500/60 bg-rose-950/40 text-rose-300' },
                    { id: 'ABANDONED', label: 'Abandoned / Paused', color: 'border-slate-500/60 bg-slate-800 text-slate-300' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setOutcome(opt.id as any)}
                      className={`py-2 px-3 text-xs font-medium rounded-lg border text-left transition ${
                        outcome === opt.id ? `${opt.color} ring-2 ring-indigo-500 font-bold` : 'border-slate-800 bg-slate-800/40 text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Perceived Difficulty & Struggle Type */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                    Perceived Difficulty
                  </label>
                  <div className="flex gap-2">
                    {(['EASY', 'NORMAL', 'HARD'] as const).map((diff) => (
                      <button
                        key={diff}
                        type="button"
                        onClick={() => setPerceivedDifficulty(diff)}
                        className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition ${
                          perceivedDifficulty === diff
                            ? diff === 'EASY' 
                              ? 'bg-emerald-600 text-white border-emerald-500'
                              : diff === 'NORMAL' 
                              ? 'bg-blue-600 text-white border-blue-500'
                              : 'bg-rose-600 text-white border-rose-500'
                            : 'border-slate-800 bg-slate-800 text-slate-400 hover:bg-slate-700'
                        }`}
                      >
                        {diff}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                    Primary Struggle (if any)
                  </label>
                  <select
                    value={struggleType}
                    onChange={(e) => setStruggleType(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="NONE">None / Smooth Execution</option>
                    <option value="ALGORITHM_IDENTIFICATION">Algorithm / Approach Discovery</option>
                    <option value="IMPLEMENTATION_BUG">Implementation Bug / Logic Flaw</option>
                    <option value="EDGE_CASE">Corner Case / Out of Bounds</option>
                    <option value="TIME_LIMIT">Time Limit Exceeded (TLE)</option>
                    <option value="MATH_TRICK">Math / Invariant Formulation</option>
                  </select>
                </div>
              </div>

              {/* Key Takeaway */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  Key Takeaway / Pattern to Remember
                </label>
                <input
                  type="text"
                  value={keyTakeaway}
                  onChange={(e) => setKeyTakeaway(e.target.value)}
                  placeholder="e.g. Always check N=1; Sorting by ratio simplifies monotonic exchange..."
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Reflection Notes */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Detailed Notes / Mental Sandbox
                </label>
                <textarea
                  rows={2}
                  value={reflectionNotes}
                  onChange={(e) => setReflectionNotes(e.target.value)}
                  placeholder="What was the bottleneck? What question should you ask yourself next time?"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              {error && (
                <div className="p-3 bg-rose-950/50 border border-rose-800/80 rounded-lg text-rose-300 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center gap-2 px-5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition disabled:opacity-50 shadow-md shadow-indigo-950/40"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {isSubmitting ? 'Saving...' : 'Save & Record Reflection'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
