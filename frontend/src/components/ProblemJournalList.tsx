import React from 'react';
import { BookOpen, CheckCircle2, FileText, MessageSquare } from 'lucide-react';
import { ProblemLearningEvent } from '../types';

interface Props {
  events: ProblemLearningEvent[];
}

const sourceLabels: Record<ProblemLearningEvent['source'], string> = {
  DAILY_ENCOUNTER: 'Daily problem opened',
  DAILY_FEEDBACK: 'Daily feedback',
  VERIFIED_CODEFORCES: 'Verified Codeforces result',
  CONTEST_REVIEW: 'Contest review',
  SOLVE_SESSION: 'Solve session',
};

export const ProblemJournalList: React.FC<Props> = ({ events }) => (
  <section className="space-y-3">
    <div>
      <h2 className="text-sm font-bold text-white flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-cyan-400" />
        Persistent Problem Journal
      </h2>
      <p className="text-xs text-slate-500 mt-1">
        Verified results and personal reflections are preserved as separate learning events.
      </p>
    </div>
    {events.length === 0 ? (
      <div className="p-6 rounded-xl border border-slate-800 bg-slate-900/60 text-xs text-slate-500">
        Your problem reflections and verified outcomes will appear here.
      </div>
    ) : (
      <div className="space-y-2">
        {events.map((event) => (
          <article key={event.id} className="p-3 rounded-lg border border-slate-800 bg-slate-900/60 text-xs space-y-1.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-white">
                  {event.contestId && event.problemIndex ? `${event.contestId}${event.problemIndex}. ` : ''}{event.problemName}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {sourceLabels[event.source]} · {new Date(event.occurredAt).toLocaleString()}
                </div>
              </div>
              {event.verifiedAc && (
                <span className="text-emerald-400 flex items-center gap-1 shrink-0">
                  <CheckCircle2 className="w-3 h-3" /> Verified AC
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 text-[10px] text-slate-400">
              {event.rating && <span className="text-cyan-400">Rating {event.rating}</span>}
              {event.solvedStatus && <span>Outcome: {event.solvedStatus.replace(/_/g, ' ')}</span>}
              {event.perceivedDifficulty && <span>Difficulty: {event.perceivedDifficulty}</span>}
              {event.struggleReason && <span>Difficulty area: {event.struggleReason.replace(/_/g, ' ')}</span>}
            </div>
            {event.notes && (
              <div className="flex items-start gap-1.5 text-slate-400 border-t border-slate-800/70 pt-1.5">
                <FileText className="w-3 h-3 text-cyan-400 mt-0.5 shrink-0" />
                <span>{event.notes}</span>
              </div>
            )}
            {(event.hintsRevealed || event.editorialViewed) && (
              <div className="flex items-center gap-1.5 text-[10px] text-amber-400">
                <MessageSquare className="w-3 h-3" />
                {event.hintsRevealed ? `${event.hintsRevealed} hint(s)` : ''}
                {event.hintsRevealed && event.editorialViewed ? ' · ' : ''}
                {event.editorialViewed ? 'editorial viewed' : ''}
              </div>
            )}
          </article>
        ))}
      </div>
    )}
  </section>
);
