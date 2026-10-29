import React, { useState } from 'react';
import { 
  ExternalLink, 
  CheckCircle2, 
  HelpCircle, 
  BookOpen, 
  XCircle, 
  Clock, 
  Tag, 
  Sparkles, 
  Save, 
  ChevronDown, 
  ChevronUp,
  FileText,
  Lightbulb,
  Loader2
} from 'lucide-react';
import {
  DailyProblem,
  FeedbackPayload,
  ProblemSolvedStatus,
  PerceivedDifficulty,
  DifficultyExperience,
  FeedbackSolutionMethod,
  FeedbackStruggleReason,
  ProblemOpinion,
  ProblemTutorial,
} from '../types';
import { TutorialModal } from './TutorialModal';
import { fetchProblemTutorial, openProblem } from '../api';

interface DailyProblemCardProps {
  problemItem: DailyProblem;
  onSaveFeedback: (problemId: string, payload: FeedbackPayload) => Promise<void>;
}

export const DailyProblemCard: React.FC<DailyProblemCardProps> = ({ problemItem, onSaveFeedback }) => {
  const p = problemItem.problem;
  const cfUrl = p ? `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` : '#';

  const [isExpanded, setIsExpanded] = useState(false);
  const [solvedStatus, setSolvedStatus] = useState<ProblemSolvedStatus>(
    problemItem.solvedStatus || 'NOT_SOLVED'
  );
  const [perceivedDifficulty, setPerceivedDifficulty] = useState<PerceivedDifficulty | null>(
    problemItem.perceivedDifficulty || null
  );
  const [difficultyExperience, setDifficultyExperience] = useState<DifficultyExperience | null>(
    problemItem.difficultyExperience || null
  );
  const [solutionMethod, setSolutionMethod] = useState<FeedbackSolutionMethod | null>(
    problemItem.solutionMethod || null
  );
  const [struggleReason, setStruggleReason] = useState<FeedbackStruggleReason | ''>(
    (problemItem.struggleReason as FeedbackStruggleReason | null) || ''
  );
  const [problemOpinion, setProblemOpinion] = useState<ProblemOpinion | ''>(
    (problemItem.problemOpinion as ProblemOpinion | null) || ''
  );
  const [timeSpentMinutes, setTimeSpentMinutes] = useState<number | ''>(
    problemItem.timeSpentMinutes !== null && problemItem.timeSpentMinutes !== undefined ? problemItem.timeSpentMinutes : ''
  );
  const [notes, setNotes] = useState<string>(problemItem.notes || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialData, setTutorialData] = useState<ProblemTutorial | null>(problemItem.tutorial || null);
  const [loadingTutorial, setLoadingTutorial] = useState(false);

  const recordEncounter = () => {
    if (problemItem.isOpened) return;
    void openProblem(problemItem.id).catch((error) => {
      console.error('Failed to record problem encounter:', error);
    });
  };

  const handleOpenTutorial = async () => {
    if (tutorialData) {
      setShowTutorial(true);
      return;
    }
    setLoadingTutorial(true);
    try {
      const data = await fetchProblemTutorial(problemItem.problemId);
      setTutorialData(data);
      setShowTutorial(true);
    } catch (e) {
      console.error('Failed to load tutorial:', e);
    } finally {
      setLoadingTutorial(false);
    }
  };

  // Category badge styling
  const categoryConfig = {
    WEAKNESS_DRILL: {
      label: 'Weakness Drill',
      color: 'bg-rose-950/60 text-rose-300 border-rose-800/60',
      dot: 'bg-rose-400',
    },
    REINFORCEMENT: {
      label: 'Reinforcement',
      color: 'bg-amber-950/60 text-amber-300 border-amber-800/60',
      dot: 'bg-amber-400',
    },
    CHALLENGE: {
      label: 'Challenge',
      color: 'bg-purple-950/60 text-purple-300 border-purple-800/60',
      dot: 'bg-purple-400',
    },
  }[problemItem.category] || {
    label: problemItem.category,
    color: 'bg-slate-800 text-slate-300 border-slate-700',
    dot: 'bg-slate-400',
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSaveSuccess(false);
    try {
      await onSaveFeedback(problemItem.id, {
        solvedStatus,
        perceivedDifficulty,
        difficultyExperience,
        solutionMethod,
        timeSpentMinutes: timeSpentMinutes === '' ? null : Number(timeSpentMinutes),
        notes: notes.trim() || null,
        struggleReason: struggleReason || null,
        problemOpinion: problemOpinion || null,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isCompleted = problemItem.completed || (problemItem.solvedStatus && problemItem.solvedStatus !== 'NOT_SOLVED');

  return (
    <div className={`rounded-xl border transition-all duration-200 ${
      isCompleted 
        ? 'bg-slate-900/90 border-slate-700 shadow-sm' 
        : 'bg-slate-900/60 border-slate-800/90 hover:border-slate-700'
    }`}>
      {/* Header Info */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${categoryConfig.color}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${categoryConfig.dot}`} />
              {categoryConfig.label}
            </span>

            {p?.rating ? (
              <span className="text-xs px-2 py-0.5 rounded-md bg-slate-950 text-cyan-400 border border-slate-800 font-mono font-medium">
                ★ {p.rating}
              </span>
            ) : null}

            {isCompleted && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2 py-0.5 rounded font-medium">
                <CheckCircle2 className="w-3 h-3" />
                Done
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleOpenTutorial}
              disabled={loadingTutorial}
              className="flex items-center gap-1.5 text-xs text-cyan-300 hover:text-cyan-100 font-semibold px-2.5 py-1 rounded bg-cyan-950/70 hover:bg-cyan-900 border border-cyan-700/60 transition-all shrink-0 shadow-sm"
              title="Open progressive hints and masterclass tutorial"
            >
              {loadingTutorial ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              ) : (
                <Lightbulb className="w-3.5 h-3.5 text-cyan-400" />
              )}
              <span>Hints & Tutorial</span>
            </button>

            <a
              href={cfUrl}
              target="_blank"
              rel="noreferrer"
              onClick={recordEncounter}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-cyan-300 font-medium px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700/60 transition-all shrink-0"
            >
              <span>Codeforces</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Problem Title */}
        <h4 className="text-base font-bold text-white mt-3 flex items-baseline gap-2">
          <span>{p?.contestId}{p?.index}.</span>
          <a 
            href={cfUrl} 
            target="_blank" 
            rel="noreferrer" 
            onClick={recordEncounter}
            className="hover:text-cyan-400 hover:underline transition-colors"
          >
            {p?.name || 'Problem Assignment'}
          </a>
        </h4>

        {/* Tags */}
        {p?.tags && p.tags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
            <Tag className="w-3 h-3 text-slate-500" />
            {p.tags.map((tag) => (
              <span 
                key={tag} 
                className="text-[11px] px-2 py-0.5 rounded bg-slate-950 text-slate-400 border border-slate-800 font-mono"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Reason rationale */}
        <div className="mt-3 p-3 rounded-lg bg-slate-950/70 border border-slate-800/80 text-xs text-slate-300 flex items-start gap-2.5">
          <Sparkles className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <span className="font-semibold text-slate-200">Coach Rationale:</span>
            <p className="text-slate-400 leading-relaxed">{problemItem.reason}</p>
          </div>
        </div>

        {/* Feedback Summary or Toggle */}
        <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs">
            {problemItem.solvedStatus && problemItem.solvedStatus !== 'NOT_SOLVED' ? (
              <div className="flex items-center gap-2">
                <span className="text-slate-400 font-medium">Status:</span>
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  {problemItem.solvedStatus === 'SOLVED_INDEPENDENTLY' && 'Solved Independently'}
                  {problemItem.solvedStatus === 'SOLVED_WITH_HINTS' && 'Solved with Hints'}
                  {problemItem.solvedStatus === 'VIEWED_EDITORIAL' && 'Viewed Editorial'}
                </span>
                {problemItem.perceivedDifficulty && (
                  <span className="text-slate-400">
                    • Difficulty: <span className="text-slate-200 font-medium">{problemItem.perceivedDifficulty}</span>
                  </span>
                )}
                {problemItem.timeSpentMinutes ? (
                  <span className="text-slate-400">
                    • <span className="font-mono text-slate-200">{problemItem.timeSpentMinutes}m</span>
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="text-slate-500 text-xs">Pending feedback submission</span>
            )}
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-slate-800 transition-all"
          >
            <span>{isExpanded ? 'Hide Feedback' : 'Record Feedback'}</span>
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Expandable Feedback Form */}
      {isExpanded && (
        <form onSubmit={handleSave} className="p-5 border-t border-slate-800 bg-slate-950/40 rounded-b-xl space-y-4">
          {/* 1. Solved Status */}
          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-2">
              How did you solve this problem?
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => setSolvedStatus('SOLVED_INDEPENDENTLY')}
                className={`flex items-center justify-center gap-1.5 p-2 rounded-lg text-xs font-medium border transition-all ${
                  solvedStatus === 'SOLVED_INDEPENDENTLY'
                    ? 'bg-emerald-950 border-emerald-500 text-emerald-200 shadow-sm'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Independently</span>
              </button>

              <button
                type="button"
                onClick={() => setSolvedStatus('SOLVED_WITH_HINTS')}
                className={`flex items-center justify-center gap-1.5 p-2 rounded-lg text-xs font-medium border transition-all ${
                  solvedStatus === 'SOLVED_WITH_HINTS'
                    ? 'bg-cyan-950 border-cyan-500 text-cyan-200 shadow-sm'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />
                <span>With Hints</span>
              </button>

              <button
                type="button"
                onClick={() => setSolvedStatus('VIEWED_EDITORIAL')}
                className={`flex items-center justify-center gap-1.5 p-2 rounded-lg text-xs font-medium border transition-all ${
                  solvedStatus === 'VIEWED_EDITORIAL'
                    ? 'bg-amber-950 border-amber-500 text-amber-200 shadow-sm'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5 text-amber-400" />
                <span>Used Editorial</span>
              </button>

              <button
                type="button"
                onClick={() => setSolvedStatus('NOT_SOLVED')}
                className={`flex items-center justify-center gap-1.5 p-2 rounded-lg text-xs font-medium border transition-all ${
                  solvedStatus === 'NOT_SOLVED'
                    ? 'bg-rose-950 border-rose-500 text-rose-200 shadow-sm'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <XCircle className="w-3.5 h-3.5 text-rose-400" />
                <span>Not Solved</span>
              </button>
            </div>
          </div>

          {/* 2. Perceived Difficulty & Time Spent */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-2">
                Perceived Difficulty
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['EASY', 'NORMAL', 'HARD'] as PerceivedDifficulty[]).map((diff) => (
                  <button
                    key={diff}
                    type="button"
                    onClick={() => setPerceivedDifficulty(diff)}
                    className={`p-2 rounded-lg text-xs font-medium border transition-all text-center ${
                      perceivedDifficulty === diff
                        ? diff === 'EASY'
                          ? 'bg-emerald-950 border-emerald-500 text-emerald-300'
                          : diff === 'NORMAL'
                          ? 'bg-cyan-950 border-cyan-500 text-cyan-300'
                          : 'bg-rose-950 border-rose-500 text-rose-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {diff}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-2">
                Time Spent (Minutes)
              </label>
              <div className="relative">
                <Clock className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="number"
                  min="1"
                  max="480"
                  placeholder="e.g. 35"
                  value={timeSpentMinutes}
                  onChange={(e) => setTimeSpentMinutes(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
          </div>

          {/* 3. Optional learning diagnosis */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="text-xs font-semibold text-slate-300">
              <span className="block mb-2">How did the difficulty feel?</span>
              <select
                value={difficultyExperience || ''}
                onChange={(e) => setDifficultyExperience((e.target.value || null) as DifficultyExperience | null)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                <option value="">Optional</option>
                <option value="MUCH_EASIER">Much easier than expected</option>
                <option value="SLIGHTLY_EASY">Slightly easy</option>
                <option value="APPROPRIATE">Appropriate for my level</option>
                <option value="CHALLENGING">Challenging but manageable</option>
                <option value="MUCH_HARDER">Much harder than expected</option>
              </select>
            </label>

            <label className="text-xs font-semibold text-slate-300">
              <span className="block mb-2">What challenged you most?</span>
              <select
                value={struggleReason}
                onChange={(e) => setStruggleReason(e.target.value as FeedbackStruggleReason | '')}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                <option value="">Optional</option>
                <option value="KEY_OBSERVATION">Recognizing the key observation</option>
                <option value="ALGORITHM_CHOICE">Choosing the algorithm or data structure</option>
                <option value="PROOF">Proving correctness</option>
                <option value="IMPLEMENTATION">Implementation</option>
                <option value="DEBUGGING">Debugging wrong answers</option>
                <option value="EDGE_CASES">Edge cases or complexity</option>
              </select>
            </label>

            <label className="text-xs font-semibold text-slate-300">
              <span className="block mb-2">How much help did you need?</span>
              <select
                value={solutionMethod || ''}
                onChange={(e) => setSolutionMethod((e.target.value || null) as FeedbackSolutionMethod | null)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                <option value="">Optional</option>
                <option value="INDEPENDENT">Independently</option>
                <option value="HINTS">After one or more hints</option>
                <option value="EDITORIAL">After viewing the editorial</option>
                <option value="IDEA_IMPLEMENTATION">Understood the idea, struggled to implement</option>
                <option value="NOT_SOLVED">Still could not solve it</option>
              </select>
            </label>

            <label className="text-xs font-semibold text-slate-300">
              <span className="block mb-2">Was it a good fit?</span>
              <select
                value={problemOpinion}
                onChange={(e) => setProblemOpinion(e.target.value as ProblemOpinion | '')}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
              >
                <option value="">Optional</option>
                <option value="USEFUL_RELEVANT">Useful and relevant</option>
                <option value="INTERESTING_TOO_EASY">Interesting but too easy</option>
                <option value="TOO_DIFFICULT">Too difficult for my level</option>
                <option value="REPETITIVE_FAMILIAR">Repetitive or already familiar</option>
                <option value="POOR_FIT">Poor fit for my current goals</option>
              </select>
            </label>
          </div>

          {/* 4. Personal Notes */}
          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-2 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-slate-400" />
              <span>Personal Reflection & Key Takeaways</span>
            </label>
            <textarea
              rows={2}
              placeholder="What trick or edge case did you learn? (e.g., prefix sums on modular inverse, 1-based indexing gotcha)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 resize-none"
            />
          </div>

          {/* Save Button */}
          <div className="flex items-center justify-between pt-2">
            <span className="text-[11px] text-slate-500">
              *Feedback directly fine-tunes future weakness prioritization.
            </span>
            <div className="flex items-center gap-2">
              {saveSuccess && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Saved!
                </span>
              )}
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold shadow-md shadow-cyan-950/40 transition-all active:scale-95 disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{isSubmitting ? 'Saving...' : 'Save Feedback'}</span>
              </button>
            </div>
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
