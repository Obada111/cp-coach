import React, { useState, useEffect, useCallback } from 'react';
import {
  UserContestSummary,
  ContestPostMortem,
  SelfReviewTag,
  ContestUpsolveStatus,
  ProblemTutorial,
} from '../types';
import {
  fetchContests,
  syncContests,
  importContest,
  fetchContestPostMortem,
  submitContestProblemReview,
  fetchContestProblemTutorial,
  sendContestProblemToReview,
} from '../api';
import {
  Trophy,
  RefreshCw,
  Plus,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  ChevronRight,
  Loader2,
  Sparkles,
  Save,
  Layers,
  Lightbulb,
  Search,
  BookOpen,
  Filter,
  RotateCcw,
} from 'lucide-react';
import { TutorialModal } from './TutorialModal';
import { VirtualContestSession } from './VirtualContestSession';

interface Props {
  profileId: string;
  onNavigateToPractice?: () => void;
}

const SELF_REVIEW_OPTIONS: Array<{ value: SelfReviewTag; label: string }> = [
  { value: 'DID_NOT_RECOGNIZE_ALGORITHM', label: 'Did not recognize algorithm / idea' },
  { value: 'STRUGGLED_WITH_IMPLEMENTATION', label: 'Understood idea, struggled with implementation' },
  { value: 'BUG_DEBUGGING_DIFFICULTY', label: 'Had a bug and could not debug quickly' },
  { value: 'RAN_OUT_OF_TIME', label: 'Ran out of time during contest' },
  { value: 'CARELESS_MISTAKE', label: 'Knew solution, made careless mistake' },
  { value: 'SOLVED_DURING_UPSOLVING', label: 'Solved during post-contest upsolving' },
  { value: 'OTHER', label: 'Other (see notes)' },
];

export const ContestsView: React.FC<Props> = ({ profileId, onNavigateToPractice }) => {
  const [contests, setContests] = useState<UserContestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selected contest for detailed post-mortem
  const [selectedContestId, setSelectedContestId] = useState<number | null>(null);
  const [postMortem, setPostMortem] = useState<ContestPostMortem | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  // Import modal / form state
  const [showImportForm, setShowImportForm] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Problem review editing state (problemIndex -> state)
  const [editingProblem, setEditingProblem] = useState<string | null>(null);
  const [reviewTag, setReviewTag] = useState<SelfReviewTag | ''>('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewUpsolve, setReviewUpsolve] = useState<ContestUpsolveStatus>('UNSOLVED');
  const [savingReview, setSavingReview] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Division & Participation Filters + Search
  const [selectedDivFilter, setSelectedDivFilter] = useState<string>('ALL');
  const [selectedParticipationFilter, setSelectedParticipationFilter] = useState<'OFFICIAL' | 'RATED' | 'MISSED' | 'PRACTICE' | 'ALL'>('OFFICIAL');
  const [searchQuery, setSearchQuery] = useState('');

  // Tutorial modal state for contest problems
  const [activeTutorial, setActiveTutorial] = useState<ProblemTutorial | null>(null);
  const [tutorialModalOpen, setTutorialModalOpen] = useState(false);
  const [loadingTutorialIndex, setLoadingTutorialIndex] = useState<string | null>(null);
  const [virtualMode, setVirtualMode] = useState(false);

  // Load contest list
  const loadContests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchContests(profileId);
      setContests(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load contests');
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    loadContests();
  }, [loadContests]);

  // Handle sync
  const handleSyncContests = async () => {
    setSyncing(true);
    try {
      const res = await syncContests(profileId);
      setContests(res.contests);
    } catch (err: any) {
      setError(err.message || 'Contest synchronization failed');
    } finally {
      setSyncing(false);
    }
  };

  // Handle import
  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importInput.trim()) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await importContest(importInput.trim(), profileId);
      setShowImportForm(false);
      setImportInput('');
      await loadContests();
      setPostMortem(res.report);
      setSelectedContestId(res.report.contestId);
    } catch (err: any) {
      setImportError(err.message || 'Failed to import contest');
    } finally {
      setImporting(false);
    }
  };

  // Open post-mortem for a contest
  const handleSelectContest = async (contestId: number) => {
    setSelectedContestId(contestId);
    setLoadingReport(true);
    setEditingProblem(null);
    try {
      const report = await fetchContestPostMortem(contestId, profileId);
      setPostMortem(report);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingReport(false);
    }
  };

  // Open problem review editor
  const handleStartReview = (prob: any) => {
    setEditingProblem(prob.index);
    setReviewTag(prob.selfReviewTag || '');
    setReviewNotes(prob.selfReviewNotes || '');
    setReviewUpsolve(prob.upsolveStatus || 'UNSOLVED');
    setSavedSuccess(false);
  };

  // Submit problem review
  const handleSaveReview = async (problemIndex: string) => {
    if (!selectedContestId) return;
    setSavingReview(true);
    try {
      const res = await submitContestProblemReview(
        selectedContestId,
        problemIndex,
        {
          selfReviewTag: reviewTag || null,
          selfReviewNotes: reviewNotes.trim() || null,
          upsolveStatus: reviewUpsolve,
        },
        profileId
      );
      setPostMortem(res.report);
      setSavedSuccess(true);
      setTimeout(() => {
        setSavedSuccess(false);
        setEditingProblem(null);
      }, 1500);
    } catch (err: any) {
      alert(`Could not save review: ${err.message}`);
    } finally {
      setSavingReview(false);
    }
  };

  const handleOpenTutorialForContestProblem = async (prob: any) => {
    if (prob.tutorial) {
      setActiveTutorial(prob.tutorial);
      setTutorialModalOpen(true);
      return;
    }
    if (!selectedContestId) return;
    setLoadingTutorialIndex(prob.index);
    try {
      const tut = await fetchContestProblemTutorial(selectedContestId, prob.index);
      setActiveTutorial(tut);
      setTutorialModalOpen(true);
    } catch (e) {
      console.error('Failed to load contest problem tutorial:', e);
    } finally {
      setLoadingTutorialIndex(null);
    }
  };

  const handleAddAsDailyWeakness = async (prob: any) => {
    if (!selectedContestId) return;
    try {
      const res = await submitContestProblemReview(
        selectedContestId,
        prob.index,
        {
          selfReviewTag: 'DID_NOT_RECOGNIZE_ALGORITHM',
          selfReviewNotes: `Struggled in contest on ${prob.name}. Flagged for daily targeted practice.`,
          upsolveStatus: prob.upsolveStatus || 'UNSOLVED',
        },
        profileId
      );
      setPostMortem(res.report);
      alert(`Contest struggle on "${prob.name}" recorded! Your future daily 3 problems will prioritize practice on this topic.`);
    } catch (err: any) {
      alert(`Could not flag weakness: ${err.message}`);
    }
  };

  const handleEnqueueToSpacedRepetition = async (prob: any) => {
    if (!selectedContestId) return;
    try {
      await sendContestProblemToReview(
        selectedContestId,
        prob.index,
        `Contest ${selectedContestId} problem ${prob.index}: ${prob.name}`,
        profileId
      );
      alert(`Problem "${prob.name}" enqueued to your Spaced Repetition review loop!`);
    } catch (err: any) {
      alert(`Could not enqueue to spaced repetition: ${err.message}`);
    }
  };

  // ─── Post-Mortem Loading & Detail View ───
  if (selectedContestId && loadingReport) {
    return (
      <div className="py-20 text-center text-xs text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-cyan-400" />
        Generating detailed contest post-mortem report...
      </div>
    );
  }

  if (selectedContestId && postMortem) {
    if (virtualMode) {
      return (
        <VirtualContestSession
          profileId={profileId}
          handle={postMortem.handle}
          contestId={postMortem.contestId}
          name={postMortem.name}
          durationSeconds={postMortem.durationSeconds}
          problems={postMortem.problems}
          onClose={() => setVirtualMode(false)}
        />
      );
    }

    const hasDelta = postMortem.ratingChange !== null && postMortem.ratingChange !== undefined;
    const isPositive = (postMortem.ratingChange || 0) >= 0;
    const canStartVirtualContest =
      postMortem.contestId > 0 &&
      postMortem.contestId < 100000 &&
      postMortem.startTimeSeconds + postMortem.durationSeconds < Math.floor(Date.now() / 1000) &&
      postMortem.problems.length > 0;

    return (
      <div className="space-y-6">
        {/* Back navigation & header */}
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => { setSelectedContestId(null); setPostMortem(null); }}
            className="text-xs text-slate-400 hover:text-white flex items-center gap-1 transition-colors"
          >
            ← Back to contests
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
              {postMortem.participationType}
            </span>
            <a
              href={`https://codeforces.com/contest/${postMortem.contestId}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-medium transition-colors"
            >
              Codeforces <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Contest Header Card */}
        <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">{postMortem.name}</h2>
              <div className="flex items-center gap-3 text-xs text-slate-400 mt-1 flex-wrap">
                <span>{postMortem.startTimeFormatted}</span>
                <span>·</span>
                <span>{Math.round(postMortem.durationSeconds / 60)} min duration</span>
                {postMortem.rank && (
                  <>
                    <span>·</span>
                    <span className="text-slate-300 font-semibold">Rank #{postMortem.rank.toLocaleString()}</span>
                  </>
                )}
              </div>
            </div>

            {canStartVirtualContest && (
              <button
                type="button"
                onClick={() => setVirtualMode(true)}
                className="px-3 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-xs font-semibold text-white"
              >
                Start Virtual Contest
              </button>
            )}

            {/* Rating Change Display */}
            {hasDelta && (
              <div className="text-right">
                <div className={`text-xl font-bold font-mono ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {isPositive ? `+${postMortem.ratingChange}` : postMortem.ratingChange}
                </div>
                <div className="text-[11px] text-slate-500">
                  {postMortem.oldRating} → {postMortem.newRating}
                </div>
              </div>
            )}
          </div>

          {/* Key Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-800/80">
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60">
              <div className="text-[11px] text-slate-500">Problems Solved</div>
              <div className="text-lg font-bold text-emerald-400 mt-0.5">
                {postMortem.problemsSolved} <span className="text-xs text-slate-500 font-normal">/ {postMortem.problems.length}</span>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60">
              <div className="text-[11px] text-slate-500">Attempted</div>
              <div className="text-lg font-bold text-white mt-0.5">
                {postMortem.problemsAttempted}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60">
              <div className="text-[11px] text-slate-500">Unsuccessful Attempts</div>
              <div className="text-lg font-bold text-amber-400 mt-0.5">
                {postMortem.unsuccessfulAttempts}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/60">
              <div className="text-[11px] text-slate-500">Upsolved Post-Contest</div>
              <div className="text-lg font-bold text-cyan-400 mt-0.5">
                {postMortem.upsolvingSummary.upsolvedCount}
              </div>
            </div>
          </div>

          {/* Historical context note */}
          <p className="text-xs text-slate-400 bg-slate-950/40 p-3 rounded-xl border border-slate-800/40 leading-relaxed">
            <span className="font-semibold text-slate-300">Historical Comparison:</span> {postMortem.performanceVsHistorical}
          </p>
        </div>

        {/* ── Section B & Review: Problem-by-Problem Table ── */}
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Layers className="w-4 h-4 text-cyan-400" />
            Problem-by-Problem Post-Mortem & Self-Review
          </h3>

          <div className="space-y-3">
            {postMortem.problems.map((prob) => {
              const isSolved = prob.status === 'SOLVED_IN_CONTEST';
              const isAttemptedUnsolved = prob.status === 'ATTEMPTED_UNSOLVED';
              const isNoSub = prob.status === 'NO_RECORDED_SUBMISSION';
              const isEditing = editingProblem === prob.index;

              return (
                <div
                  key={prob.index}
                  className={`p-4 rounded-xl border transition-all ${
                    isSolved
                      ? 'bg-slate-900/60 border-emerald-900/40'
                      : isAttemptedUnsolved
                      ? 'bg-slate-900/80 border-rose-900/40'
                      : 'bg-slate-900/40 border-slate-800/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-white font-mono">{prob.index}.</span>
                        <a
                          href={prob.cfUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-bold text-sm text-white hover:text-cyan-300 transition-colors"
                        >
                          {prob.name}
                        </a>
                        {prob.rating && (
                          <span className="text-[11px] font-mono text-cyan-400/90 bg-cyan-950/40 px-2 py-0.5 rounded">
                            {prob.rating}
                          </span>
                        )}

                        {/* Status Badge */}
                        {isSolved && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300 font-semibold bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Solved in Contest
                          </span>
                        )}
                        {isAttemptedUnsolved && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-rose-300 font-semibold bg-rose-950/60 border border-rose-800/50 px-2 py-0.5 rounded-full">
                            <XCircle className="w-3 h-3 text-rose-400" /> Attempted ({prob.submissionsCount} subs)
                          </span>
                        )}
                        {isNoSub && (
                          <span className="text-[11px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded-full">
                            No recorded submission
                          </span>
                        )}

                        {/* Upsolve Badge */}
                        {prob.upsolveStatus !== 'IN_CONTEST_SOLVED' && prob.upsolveStatus !== 'UNSOLVED' && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-cyan-300 font-medium bg-cyan-950/60 border border-cyan-800/40 px-2 py-0.5 rounded-full">
                            ✓ {prob.upsolveStatus.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>

                      {/* Tags */}
                      {prob.tags.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                          {prob.tags.map((t) => (
                            <span key={t} className="text-[10px] text-slate-500 bg-slate-800/60 px-1.5 py-0.5 rounded font-mono">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Timing & Submissions */}
                    <div className="text-right text-xs font-mono text-slate-400 space-y-0.5">
                      {prob.firstAttemptFormatted && (
                        <div>First try: <span className="text-slate-200">{prob.firstAttemptFormatted}</span></div>
                      )}
                      {prob.solvedFormatted && (
                        <div>AC at: <span className="text-emerald-400 font-semibold">{prob.solvedFormatted}</span></div>
                      )}
                      {prob.timeSpentMinutes !== null && prob.timeSpentMinutes !== undefined && prob.timeSpentMinutes > 0 && (
                        <div className="text-[11px] text-slate-500">{prob.timeSpentMinutes} min elapsed</div>
                      )}
                    </div>
                  </div>

                  {/* Verdict Sequence */}
                  {prob.verdictSequence.length > 0 && (
                    <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] text-slate-500 font-mono">Verdicts:</span>
                      {prob.verdictSequence.map((v, i) => (
                        <span
                          key={i}
                          className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${
                            v === 'OK'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : v === 'WRONG_ANSWER'
                              ? 'bg-rose-950 text-rose-300 border border-rose-800'
                              : 'bg-amber-950 text-amber-300 border border-amber-800'
                          }`}
                        >
                          {v === 'OK' ? 'AC' : v === 'WRONG_ANSWER' ? 'WA' : v === 'TIME_LIMIT_EXCEEDED' ? 'TLE' : v}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Observations */}
                  {prob.observations.length > 0 && (
                    <ul className="mt-2 text-xs text-slate-400 list-disc list-inside space-y-0.5">
                      {prob.observations.map((obs, idx) => (
                        <li key={idx}>{obs}</li>
                      ))}
                    </ul>
                  )}

                  {/* Self-Review Preview OR Editor */}
                  <div className="mt-3 pt-3 border-t border-slate-800/60 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => handleOpenTutorialForContestProblem(prob)}
                        disabled={loadingTutorialIndex === prob.index}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-950/70 hover:bg-cyan-900 border border-cyan-700/60 text-cyan-300 hover:text-cyan-100 text-xs font-semibold shadow-sm transition-all"
                      >
                        {loadingTutorialIndex === prob.index ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                        ) : (
                          <Lightbulb className="w-3.5 h-3.5 text-cyan-400" />
                        )}
                        <span>Masterclass Tutorial & Solution</span>
                      </button>

                      {isAttemptedUnsolved && (
                        <button
                          type="button"
                          onClick={() => handleAddAsDailyWeakness(prob)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-950/60 hover:bg-rose-900/60 border border-rose-800/50 text-rose-300 text-xs font-semibold transition-all"
                          title="Prioritize this struggle in your Daily 3 problems"
                        >
                          <AlertTriangle className="w-3 h-3 text-rose-400" />
                          Add to Daily Weakness Drill
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleEnqueueToSpacedRepetition(prob)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/60 border border-indigo-800/50 text-indigo-300 text-xs font-semibold transition-all"
                        title="Enqueue this problem into your Spaced Repetition review loop"
                      >
                        <RotateCcw className="w-3 h-3 text-indigo-400" />
                        Send to Spaced Repetition
                      </button>

                      <a
                        href={prob.cfUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded-lg hover:bg-slate-800 transition-colors"
                      >
                        Codeforces <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>

                    <button
                      onClick={() => (isEditing ? setEditingProblem(null) : handleStartReview(prob))}
                      className="text-xs text-cyan-400 hover:text-cyan-300 font-medium px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 transition-colors"
                    >
                      {isEditing ? 'Cancel' : prob.selfReviewTag ? 'Edit Review' : 'Add Self-Review / Upsolve'}
                    </button>
                  </div>

                  {/* Interactive Review Form */}
                  {isEditing && (
                    <div className="mt-3 p-3.5 rounded-xl bg-slate-950/80 border border-cyan-900/40 space-y-3">
                      <div className="text-xs font-semibold text-cyan-300">
                        Post-Contest Problem Review & Upsolving
                      </div>

                      {/* Reason why difficult / unsolved */}
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">What made this problem difficult?</label>
                        <select
                          value={reviewTag}
                          onChange={(e) => setReviewTag(e.target.value as SelfReviewTag)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-cyan-500"
                        >
                          <option value="">Select a reason (optional)...</option>
                          {SELF_REVIEW_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>

                      {/* Upsolving Status */}
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Upsolving Status</label>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {([
                            { v: 'IN_CONTEST_SOLVED' as const, label: 'Solved in Contest' },
                            { v: 'UPSOLVED_INDEPENDENTLY' as const, label: 'Upsolved Solo' },
                            { v: 'UPSOLVED_WITH_HINTS' as const, label: 'Upsolved w/ Hints' },
                            { v: 'UPSOLVED_WITH_EDITORIAL' as const, label: 'Upsolved w/ Editorial' },
                          ]).map((opt) => (
                            <button
                              key={opt.v}
                              type="button"
                              onClick={() => setReviewUpsolve(opt.v)}
                              className={`p-2 rounded-lg text-xs font-medium border transition-all ${
                                reviewUpsolve === opt.v
                                  ? 'bg-cyan-950/70 border-cyan-500/60 text-cyan-300'
                                  : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Personal takeaway notes */}
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">Takeaway Notes (optional)</label>
                        <textarea
                          rows={2}
                          value={reviewNotes}
                          onChange={(e) => setReviewNotes(e.target.value)}
                          placeholder="e.g. Missed binary search on answer; formulation required prefix sums..."
                          className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-cyan-500 resize-none"
                        />
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-1">
                        {savedSuccess && (
                          <span className="text-xs text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Saved!
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={savingReview}
                          onClick={() => handleSaveReview(prob.index)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-all disabled:opacity-50"
                        >
                          <Save className="w-3.5 h-3.5" />
                          {savingReview ? 'Saving...' : 'Save Review'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Section C & D: Verdict Breakdown & Strategy ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Verdict Breakdown Card */}
          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Verdict Analysis
            </h3>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
                <div className="text-emerald-400 font-bold">{postMortem.verdictBreakdown.ok}</div>
                <div className="text-[10px] text-slate-500">Accepted</div>
              </div>
              <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
                <div className="text-rose-400 font-bold">{postMortem.verdictBreakdown.wrongAnswer}</div>
                <div className="text-[10px] text-slate-500">Wrong Answer</div>
              </div>
              <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
                <div className="text-amber-400 font-bold">{postMortem.verdictBreakdown.timeLimitExceeded}</div>
                <div className="text-[10px] text-slate-500">TLE</div>
              </div>
            </div>

            {postMortem.verdictPatterns.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="text-[11px] font-semibold text-slate-400">Observed Patterns:</div>
                <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
                  {postMortem.verdictPatterns.map((pat, idx) => (
                    <li key={idx}>{pat}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Strategy & Pacing Card */}
          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-cyan-400" /> Contest Strategy & Pacing
            </h3>
            {postMortem.strategyObservations.length > 0 ? (
              <ul className="text-xs text-slate-400 space-y-2 list-disc list-inside">
                {postMortem.strategyObservations.map((obs, idx) => (
                  <li key={idx} className="leading-relaxed">{obs}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">No strategy flags recorded.</p>
            )}
          </div>
        </div>

        {/* ── Section E: Topic Weaknesses Identified in this Contest ── */}
        {postMortem.topicWeaknesses.length > 0 && (
          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" /> Contest Topic Diagnostics & Training Link
              </h3>
              {onNavigateToPractice && (
                <button
                  onClick={onNavigateToPractice}
                  className="text-xs text-cyan-400 hover:text-cyan-300 font-medium"
                >
                  Go to Today's Practice →
                </button>
              )}
            </div>

            <div className="space-y-2">
              {postMortem.topicWeaknesses.map((tw) => (
                <div
                  key={tw.tag}
                  className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/60 flex items-center justify-between gap-3 flex-wrap"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white capitalize text-xs">{tw.tag}</span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          tw.status === 'DEMONSTRATED_WEAKNESS'
                            ? 'bg-rose-950 text-rose-300 border border-rose-800'
                            : tw.status === 'POSSIBLE_WEAKNESS'
                            ? 'bg-amber-950 text-amber-300 border border-amber-800'
                            : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                        }`}
                      >
                        {tw.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400">{tw.suggestedAction}</div>
                  </div>

                  <div className="text-xs font-mono text-slate-400">
                    Contest: {tw.contestSolved}/{tw.contestAttempts} solved
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Submission Timeline ── */}
        {postMortem.timeline.length > 0 && (
          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Chronological Submission Timeline
            </h3>
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {postMortem.timeline.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-2 rounded-lg bg-slate-950/60 border border-slate-800/40 text-xs font-mono"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">{item.relativeTimeFormatted}</span>
                    <span className="text-white font-bold">Problem {item.problemIndex}</span>
                    {item.isAfterContest && (
                      <span className="text-[10px] text-cyan-400 bg-cyan-950/60 px-1.5 py-0.2 rounded font-sans">
                        Upsolve
                      </span>
                    )}
                  </div>
                  <span
                    className={`font-semibold ${
                      item.verdict === 'OK'
                        ? 'text-emerald-400'
                        : item.verdict === 'WRONG_ANSWER'
                        ? 'text-rose-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {item.verdict}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Contest List View ───
  const officialContests = contests.filter((c) => c.isOfficial || c.participationType === 'RATED' || c.participationType === 'MISSED');
  const officialCount = officialContests.length;
  const ratedCount = contests.filter((c) => c.participationType === 'RATED').length;
  const missedCount = contests.filter((c) => c.participationType === 'MISSED').length;
  const practiceCount = contests.filter((c) => c.participationType === 'PRACTICE').length;

  const filteredContests = contests.filter((c) => {
    // Division filter
    if (selectedDivFilter !== 'ALL') {
      if (selectedDivFilter === 'Educational') {
        if (!c.name.toLowerCase().includes('educational')) return false;
      } else {
        if (!c.division || !c.division.includes(selectedDivFilter)) return false;
      }
    }
    // Participation filter
    if (selectedParticipationFilter === 'OFFICIAL' && !(c.isOfficial || c.participationType === 'RATED' || c.participationType === 'MISSED')) return false;
    if (selectedParticipationFilter === 'RATED' && c.participationType !== 'RATED') return false;
    if (selectedParticipationFilter === 'MISSED' && c.participationType !== 'MISSED') return false;
    if (selectedParticipationFilter === 'PRACTICE' && c.participationType !== 'PRACTICE') return false;
    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!c.name.toLowerCase().includes(q) && !String(c.contestId).includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Top action bar: Sync & Import */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Trophy className="w-4 h-4 text-cyan-400" />
            Codeforces Divs & Contest Post-Mortems
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Automatic tracking for every Div round (Div. 1–4, Edu), performance reviews, and masterclass tutorials for every problem.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImportForm(!showImportForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 hover:text-white transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            Import Contest
          </button>
          <button
            onClick={handleSyncContests}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-xs text-white font-semibold transition-all shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Scanning...' : 'Sync Contests'}
          </button>
        </div>
      </div>

      {/* Manual Import Form */}
      {showImportForm && (
        <form onSubmit={handleImport} className="p-4 rounded-xl bg-slate-900/90 border border-cyan-800/40 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-white">Import Contest by URL or ID</span>
            <button
              type="button"
              onClick={() => setShowImportForm(false)}
              className="text-xs text-slate-500 hover:text-white"
            >
              ✕
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Paste a Codeforces contest link (e.g. <code>https://codeforces.com/contest/1985</code>) or contest ID (e.g. <code>1985</code>).
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={importInput}
              onChange={(e) => setImportInput(e.target.value)}
              placeholder="e.g. 1985 or https://codeforces.com/contest/1985"
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
            />
            <button
              type="submit"
              disabled={importing || !importInput.trim()}
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-xs text-white font-semibold transition-all"
            >
              {importing ? 'Importing...' : 'Import'}
            </button>
          </div>
          {importError && (
            <p className="text-xs text-rose-400">{importError}</p>
          )}
        </form>
      )}

      {/* ── Filter Controls: Participation, Division, Search ── */}
      {contests.length > 0 && (
        <div className="space-y-3 bg-slate-900/60 p-3.5 rounded-xl border border-slate-800/80">
          {/* Top row: Participation Tabs + Search */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {/* Participation Filters */}
            <div className="flex items-center bg-slate-950/70 p-1 rounded-xl border border-slate-800/80 gap-1 text-xs flex-wrap">
              <button
                type="button"
                onClick={() => setSelectedParticipationFilter('OFFICIAL')}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                  selectedParticipationFilter === 'OFFICIAL'
                    ? 'bg-cyan-600 text-white font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Official Rounds ({officialCount})
              </button>
              <button
                type="button"
                onClick={() => setSelectedParticipationFilter('RATED')}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                  selectedParticipationFilter === 'RATED'
                    ? 'bg-emerald-600 text-white font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                ✓ Rated Participated ({ratedCount})
              </button>
              <button
                type="button"
                onClick={() => setSelectedParticipationFilter('MISSED')}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                  selectedParticipationFilter === 'MISSED'
                    ? 'bg-indigo-600 text-white font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Missed / Upsolve ({missedCount})
              </button>
              {practiceCount > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedParticipationFilter('PRACTICE')}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    selectedParticipationFilter === 'PRACTICE'
                      ? 'bg-slate-700 text-white font-semibold shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Archive Solves ({practiceCount})
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedParticipationFilter('ALL')}
                className={`px-2.5 py-1.5 rounded-lg font-medium transition-all ${
                  selectedParticipationFilter === 'ALL'
                    ? 'bg-slate-800 text-white font-semibold shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                All ({contests.length})
              </button>
            </div>

            {/* Search Input */}
            <div className="relative min-w-[220px]">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search round (e.g. 952, Div. 3)..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          {/* Division Pills Bar */}
          <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-800/60">
            <span className="text-[11px] font-semibold text-slate-500 mr-1 flex items-center gap-1">
              <Filter className="w-3 h-3 text-cyan-400" /> Div:
            </span>
            {([
              { key: 'ALL', label: 'All Divs' },
              { key: 'Div. 1', label: 'Div. 1' },
              { key: 'Div. 2', label: 'Div. 2' },
              { key: 'Div. 3', label: 'Div. 3' },
              { key: 'Div. 4', label: 'Div. 4' },
              { key: 'Educational', label: 'Educational' },
            ]).map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setSelectedDivFilter(d.key)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  selectedDivFilter === d.key
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'bg-slate-950/60 text-slate-400 hover:text-slate-200 border border-slate-800/60'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="py-16 text-center text-xs text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-cyan-400" />
          Loading your contest performance data...
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-900/40 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && contests.length === 0 && (
        <div className="py-16 text-center text-xs text-slate-500 bg-slate-900/40 rounded-xl border border-slate-800 space-y-3 p-4">
          <Trophy className="w-8 h-8 text-slate-600 mx-auto" />
          <div className="text-sm font-semibold text-slate-300">No contests recorded yet</div>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Click <strong>Sync Contests</strong> to automatically detect your past rated rounds, or use <strong>Import Contest</strong> with a Codeforces URL.
          </p>
          <button
            onClick={handleSyncContests}
            disabled={syncing}
            className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-xs text-white font-semibold transition-all shadow-sm"
          >
            {syncing ? 'Scanning Codeforces...' : 'Scan Contests Now'}
          </button>
        </div>
      )}

      {/* Filtered empty state */}
      {!loading && contests.length > 0 && filteredContests.length === 0 && (
        <div className="py-12 text-center text-xs text-slate-500 bg-slate-900/40 rounded-xl border border-slate-800 space-y-2 p-4">
          <p className="text-slate-400">No contests match your current division or search filter.</p>
          <button
            type="button"
            onClick={() => { setSelectedDivFilter('ALL'); setSelectedParticipationFilter('ALL'); setSearchQuery(''); }}
            className="text-xs text-cyan-400 hover:underline"
          >
            Reset Filters
          </button>
        </div>
      )}

      {/* Contest Cards List */}
      {!loading && filteredContests.length > 0 && (
        <div className="space-y-3">
          {filteredContests.map((c) => {
            const hasDelta = c.ratingChange !== null && c.ratingChange !== undefined;
            const isPositive = (c.ratingChange || 0) >= 0;

            return (
              <div
                key={c.id}
                onClick={() => handleSelectContest(c.contestId)}
                className={`p-4 rounded-xl border transition-all cursor-pointer space-y-2 group ${
                  c.participated
                    ? 'bg-slate-900/90 border-slate-800 hover:border-slate-700 hover:bg-slate-850'
                    : 'bg-slate-950/60 border-slate-800/60 hover:border-cyan-800/40 hover:bg-slate-900/60'
                }`}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-white group-hover:text-cyan-300 transition-colors">
                        {c.name}
                      </span>

                      {/* Division Pill */}
                      {c.division && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800/60">
                          {c.division}
                        </span>
                      )}

                      {/* Participation Badge */}
                      {c.participated ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-950/70 text-emerald-300 border border-emerald-800/60">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          Participated ({c.participationType})
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800/80 text-slate-400 border border-slate-700/50">
                          Missed Round · Click to Upsolve
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
                      <span>{c.startTimeFormatted}</span>
                      {c.participated && c.rank && <span>· Rank #{c.rank.toLocaleString()}</span>}
                      {c.participated ? (
                        <>
                          <span>· <strong className="text-slate-300">{c.problemsSolved}</strong> solved</span>
                          <span>· {c.totalSubmissions} submissions</span>
                        </>
                      ) : (
                        <span>· Click to study masterclass tutorials & solutions for all problems</span>
                      )}
                    </div>
                  </div>

                  {/* Rating delta or Upsolve callout */}
                  <div className="flex items-center gap-3 shrink-0">
                    {c.participated ? (
                      hasDelta ? (
                        <div className="text-right">
                          <div className={`text-base font-bold font-mono ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {isPositive ? `+${c.ratingChange}` : c.ratingChange}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {c.oldRating} → {c.newRating}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">Unrated</span>
                      )
                    ) : (
                      <span className="text-xs text-cyan-400/90 font-medium group-hover:text-cyan-300 flex items-center gap-1">
                        <BookOpen className="w-3 h-3" /> Upsolve
                      </span>
                    )}
                    <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-cyan-400 transition-colors" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Masterclass Progressive Hints & Tutorial Modal */}
      <TutorialModal
        tutorial={activeTutorial}
        isOpen={tutorialModalOpen}
        onClose={() => setTutorialModalOpen(false)}
      />
    </div>
  );
};
