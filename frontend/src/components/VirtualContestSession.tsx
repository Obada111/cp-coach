import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Flag, Loader2 } from 'lucide-react';
import { ContestProblemAnalysis } from '../types';
import { sendContestProblemToReview } from '../api';
import {
  listVirtualContestSessions,
  saveVirtualContestSession,
  VirtualContestSession as Session,
} from '../virtualContest';

interface Props {
  profileId: string;
  handle: string;
  contestId: number;
  name: string;
  durationSeconds: number;
  problems: ContestProblemAnalysis[];
  onClose: () => void;
}

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
}

export const VirtualContestSession: React.FC<Props> = ({
  profileId,
  handle,
  contestId,
  name,
  durationSeconds,
  problems,
  onClose,
}) => {
  const [session, setSession] = useState<Session | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = listVirtualContestSessions(handle).find((item) => item.contestId === contestId);
      if (saved) {
        setSession(saved);
      } else {
        const created: Session = {
          contestId,
          profileHandle: handle,
          name,
          durationSeconds,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          problems: Object.fromEntries(problems.map((problem) => [
            problem.index,
            { firstStartedAt: null, solvedAt: null },
          ])),
        };
        saveVirtualContestSession(created);
        setSession(created);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load this virtual contest.');
    }
  }, [contestId, durationSeconds, handle, name, problems]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedSeconds = session
    ? Math.min(session.durationSeconds, Math.floor((now - Date.parse(session.startedAt)) / 1000))
    : 0;
  const remainingSeconds = session ? Math.max(0, session.durationSeconds - elapsedSeconds) : durationSeconds;
  const isFinished = Boolean(session?.finishedAt) || remainingSeconds <= 0;
  const solvedCount = session
    ? Object.values(session.problems).filter((event) => event.solvedAt !== null).length
    : 0;

  const unsolvedProblems = useMemo(
    () => problems.filter((problem) => !session?.problems[problem.index]?.solvedAt),
    [problems, session]
  );

  useEffect(() => {
    if (!session || session.finishedAt || remainingSeconds > 0) return;
    const finished = { ...session, finishedAt: new Date().toISOString() };
    try {
      saveVirtualContestSession(finished);
      setSession(finished);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save contest completion.');
    }
  }, [remainingSeconds, session]);

  const persist = (next: Session) => {
    try {
      saveVirtualContestSession(next);
      setSession(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save virtual contest progress.');
    }
  };

  const startProblem = (problemIndex: string) => {
    if (!session || isFinished) return;
    const current = session.problems[problemIndex] || { firstStartedAt: null, solvedAt: null };
    if (current.firstStartedAt) return;
    persist({
      ...session,
      problems: {
        ...session.problems,
        [problemIndex]: { ...current, firstStartedAt: new Date().toISOString() },
      },
    });
  };

  const markSolved = (problemIndex: string) => {
    if (!session || isFinished) return;
    const current = session.problems[problemIndex] || { firstStartedAt: null, solvedAt: null };
    if (!current.firstStartedAt) {
      setError('Start the problem timer before recording a self-reported solve.');
      return;
    }
    persist({
      ...session,
      problems: {
        ...session.problems,
        [problemIndex]: { ...current, solvedAt: new Date().toISOString() },
      },
    });
  };

  const finishContest = () => {
    if (!session || session.finishedAt || !window.confirm('Finish this virtual contest now? The remaining time will stop.')) return;
    persist({ ...session, finishedAt: new Date().toISOString() });
  };

  const enqueueUnsolved = async () => {
    setQueueBusy(true);
    setQueueMessage(null);
    setError(null);
    let queued = 0;
    try {
      for (const problem of unsolvedProblems) {
        await sendContestProblemToReview(
          contestId,
          problem.index,
          `Virtual contest ${contestId}: upsolve ${problem.name}`,
          profileId
        );
        queued += 1;
      }
      setQueueMessage(`${queued} unsolved problem(s) added to the review queue.`);
    } catch (reason) {
      setError(`Queued ${queued} problem(s); could not queue the rest. ${reason instanceof Error ? reason.message : ''}`);
    } finally {
      setQueueBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="p-4 sm:p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-amber-950/60 border border-amber-800/60 text-[10px] font-bold text-amber-300 uppercase tracking-wide">
              <AlertTriangle className="w-3 h-3" /> Virtual practice · not an official rated participation
            </div>
            <h2 className="mt-2 text-base font-bold text-white">{name}</h2>
            <p className="text-[11px] text-slate-500 mt-1">No hints or editorials are shown during this session.</p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-white">Back to contest</button>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Time remaining</div>
            <div className={`font-mono text-3xl font-bold ${isFinished ? 'text-slate-400' : 'text-cyan-300'}`}>
              {formatClock(isFinished ? 0 : remainingSeconds)}
            </div>
          </div>
          {!isFinished && (
            <button type="button" onClick={finishContest} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 hover:text-white">
              <Flag className="w-3.5 h-3.5" /> Finish contest
            </button>
          )}
        </div>
      </header>

      {error && <p role="alert" className="p-3 rounded-lg bg-rose-950/40 border border-rose-900/60 text-xs text-rose-300">{error}</p>}

      {isFinished && (
        <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/50 space-y-2">
          <h3 className="text-sm font-bold text-white">Virtual contest report</h3>
          <p className="text-xs text-slate-300">
            {solvedCount} / {problems.length} marked solved · {Object.values(session?.problems || {}).filter((item) => item.firstStartedAt).length} problem(s) started.
            Solve events are self-reported and do not change Codeforces rating.
          </p>
          {problems.filter((problem) => session?.problems[problem.index]?.solvedAt).map((problem) => {
            const event = session!.problems[problem.index];
            const seconds = Math.max(0, Math.floor((Date.parse(event.solvedAt!) - Date.parse(event.firstStartedAt!)) / 1000));
            return <p key={problem.index} className="text-[11px] text-emerald-300">{problem.index}. {problem.name} · self-reported time to AC {formatClock(seconds)}</p>;
          })}
          {unsolvedProblems.length > 0 && (
            <div className="pt-2">
              <button type="button" onClick={() => void enqueueUnsolved()} disabled={queueBusy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-xs text-white disabled:opacity-50">
                {queueBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Add {unsolvedProblems.length} unsolved to upsolving queue
              </button>
              {queueMessage && <p role="status" className="mt-2 text-[11px] text-emerald-300">{queueMessage}</p>}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        {problems.map((problem) => {
          const event = session?.problems[problem.index] || { firstStartedAt: null, solvedAt: null };
          return (
            <article key={problem.index} className="p-3 sm:p-4 rounded-xl bg-slate-900/70 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">
                  {problem.index}. {problem.name}
                  {problem.rating && <span className="ml-2 text-[10px] font-mono text-cyan-300">{problem.rating}</span>}
                </h3>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {problem.tags.map((tag) => <span key={tag} className="text-[10px] text-slate-500">#{tag}</span>)}
                </div>
                {event.solvedAt && (
                  <p className="mt-1 text-[10px] text-emerald-300 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Self-reported solve
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a href={problem.cfUrl} target="_blank" rel="noreferrer" onClick={() => startProblem(problem.index)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] text-slate-200 hover:text-white">
                  Open problem <ExternalLink className="w-3 h-3" />
                </a>
                {!isFinished && !event.solvedAt && (
                  <button type="button" onClick={() => event.firstStartedAt ? markSolved(problem.index) : startProblem(problem.index)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-[11px] text-white">
                    <Clock className="w-3 h-3" /> {event.firstStartedAt ? 'Mark solved' : 'Start'}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};
