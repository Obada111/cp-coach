import React, { useState, useEffect } from 'react';
import { 
  Compass, 
  TrendingUp, 
  TrendingDown, 
  Minus, 
  AlertCircle, 
  Sparkles, 
  Filter
} from 'lucide-react';
import { SkillTrack, MasteryTier, ProblemLearningEvent } from '../types';
import { fetchSkillTracks } from '../api';

interface SkillTracksViewProps {
  profileId: string;
  events: ProblemLearningEvent[];
}

export const SkillTracksView: React.FC<SkillTracksViewProps> = ({ profileId, events }) => {
  const [tracks, setTracks] = useState<SkillTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterTier, setFilterTier] = useState<string>('ALL');
  const [selectedTrackKey, setSelectedTrackKey] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchSkillTracks(profileId)
      .then((res) => {
        setTracks(res.skillTracks || []);
      })
      .catch((err) => {
        console.error(err);
        setError(err.message || 'Failed to load skill tracks');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [profileId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-400">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mr-3"></div>
        Calculating evidence-based topic mastery...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 rounded-xl bg-rose-950/40 border border-rose-800 text-rose-300">
        <AlertCircle className="w-5 h-5 inline mr-2" />
        {error}
      </div>
    );
  }

  const tierColors: Record<MasteryTier, { badge: string; bar: string; text: string }> = {
    MASTERED: {
      badge: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60',
      bar: 'bg-gradient-to-r from-emerald-500 to-teal-400',
      text: 'text-emerald-400',
    },
    PROFICIENT: {
      badge: 'bg-blue-950/80 text-blue-300 border-blue-700/60',
      bar: 'bg-gradient-to-r from-blue-500 to-cyan-400',
      text: 'text-blue-400',
    },
    DEVELOPING: {
      badge: 'bg-amber-950/80 text-amber-300 border-amber-700/60',
      bar: 'bg-gradient-to-r from-amber-500 to-yellow-400',
      text: 'text-amber-400',
    },
    EMERGING: {
      badge: 'bg-orange-950/80 text-orange-300 border-orange-700/60',
      bar: 'bg-gradient-to-r from-orange-500 to-rose-400',
      text: 'text-orange-400',
    },
    UNEXPLORED: {
      badge: 'bg-slate-800 text-slate-400 border-slate-700',
      bar: 'bg-slate-600',
      text: 'text-slate-400',
    },
  };

  const filteredTracks = tracks.filter((t) => {
    if (filterTier === 'ALL') return true;
    return t.masteryTier === filterTier;
  });

  const avgMastery = tracks.length > 0
    ? Math.round(tracks.reduce((acc, t) => acc + t.masteryScore, 0) / tracks.length)
    : 0;

  const masteredCount = tracks.filter((t) => t.masteryTier === 'MASTERED').length;
  const developingCount = tracks.filter((t) => t.masteryTier === 'DEVELOPING' || t.masteryTier === 'PROFICIENT').length;
  const unexploredCount = tracks.filter((t) => t.masteryTier === 'UNEXPLORED').length;
  const getTrackEvidence = (track: SkillTrack) => {
    const relevant = events.filter((event) =>
      event.tags.some((tag) => track.tags.includes(tag.toLowerCase()))
    );
    const withOutcome = relevant.filter((event) =>
      event.solvedStatus || event.solutionMethod || event.verifiedAc
    );
    const distinctProblems = new Set(withOutcome.map((event) => event.problemId));
    const independent = new Set(withOutcome
      .filter((event) => event.solvedStatus === 'SOLVED_INDEPENDENTLY' || event.solutionMethod === 'INDEPENDENT')
      .map((event) => event.problemId));
    const hints = new Set(withOutcome
      .filter((event) => event.solvedStatus === 'SOLVED_WITH_HINTS' || event.solutionMethod === 'HINTS')
      .map((event) => event.problemId));
    const editorials = new Set(withOutcome
      .filter((event) => event.solvedStatus === 'VIEWED_EDITORIAL' || event.solutionMethod === 'EDITORIAL' || event.editorialViewed)
      .map((event) => event.problemId));
    const latestEvents = relevant.slice(0, 6);
    return { relevant, distinctProblems, independent, hints, editorials, latestEvents };
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="p-6 rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Compass className="w-5 h-5" />
              </span>
              <h2 className="text-xl font-bold text-white">Competitive Programming Skill Tracks</h2>
            </div>
            <p className="text-xs sm:text-sm text-slate-400 max-w-2xl">
              12 core algorithmic tracks modeled with positive mastery metrics (0–100%), recency weighting, and difficulty calibration to guide your climb to Codeforces Expert and Master.
            </p>
          </div>

          {/* Aggregate KPI Badges */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/60 text-center">
              <div className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-300 to-teal-300">
                {avgMastery}%
              </div>
              <div className="text-[11px] text-slate-400 uppercase font-semibold">Average Mastery</div>
            </div>

            <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/60 text-center">
              <div className="text-xl font-bold text-emerald-400">{masteredCount}</div>
              <div className="text-[11px] text-slate-400 uppercase font-semibold">Mastered</div>
            </div>

            <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/60 text-center">
              <div className="text-xl font-bold text-amber-400">{developingCount}</div>
              <div className="text-[11px] text-slate-400 uppercase font-semibold">In Progress</div>
            </div>

            <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/60 text-center">
              <div className="text-xl font-bold text-slate-400">{unexploredCount}</div>
              <div className="text-[11px] text-slate-400 uppercase font-semibold">Unexplored</div>
            </div>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center gap-2 mt-6 pt-4 border-t border-slate-800">
          <span className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mr-2">
            <Filter className="w-3.5 h-3.5" /> Filter Tracks:
          </span>
          {['ALL', 'MASTERED', 'PROFICIENT', 'DEVELOPING', 'EMERGING', 'UNEXPLORED'].map((tier) => (
            <button
              key={tier}
              onClick={() => setFilterTier(tier)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                filterTier === tier
                  ? 'bg-indigo-600 text-white font-bold shadow-sm'
                  : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {tier === 'ALL' ? 'All (12)' : tier}
            </button>
          ))}
        </div>
      </div>

      {/* Grid of 12 Tracks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredTracks.map((track) => {
          const style = tierColors[track.masteryTier] || tierColors.UNEXPLORED;
          return (
            <div
              key={track.key}
              className="bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 shadow-lg transition flex flex-col justify-between"
            >
              <div>
                {/* Top Row: Track Name & Tier Badge */}
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      {track.name}
                    </h3>
                    <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">
                      {track.description}
                    </p>
                  </div>

                  <span className={`px-2.5 py-0.5 text-xs font-bold rounded-full border ${style.badge}`}>
                    {track.masteryTier}
                  </span>
                </div>

                {/* Mastery Progress Bar */}
                <div className="my-3">
                  <div className="flex justify-between items-center text-xs mb-1.5">
                    <span className="text-slate-400 font-medium">Topic Mastery</span>
                    <span className={`font-mono font-bold ${style.text}`}>{track.masteryScore}%</span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${style.bar}`}
                      style={{ width: `${Math.max(track.masteryScore, 4)}%` }}
                    />
                  </div>
                </div>

                {/* Sub-stats Row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 py-2 px-3 rounded-xl bg-slate-800/40 border border-slate-800 text-xs mb-3">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase">Solve Rate</div>
                    <div className="font-semibold text-slate-200">{track.solveRate}%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase">Solved / Att.</div>
                    <div className="font-semibold text-slate-200">{track.solvedCount} / {track.attemptsCount}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase">Trend</div>
                    <div className="font-semibold flex items-center gap-1">
                      {track.recentTrend === 'IMPROVING' && (
                        <span className="text-emerald-400 flex items-center gap-0.5"><TrendingUp className="w-3 h-3" /> Improving</span>
                      )}
                      {track.recentTrend === 'DECLINING' && (
                        <span className="text-rose-400 flex items-center gap-0.5"><TrendingDown className="w-3 h-3" /> Declining</span>
                      )}
                      {track.recentTrend === 'STABLE' && (
                        <span className="text-slate-400 flex items-center gap-0.5"><Minus className="w-3 h-3" /> Stable</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase">Evidence</div>
                    <div className="font-semibold text-slate-200">{track.confidence.toLowerCase()} · {track.attemptsCount}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTrackKey(selectedTrackKey === track.key ? null : track.key)}
                  className="text-[11px] text-cyan-400 hover:text-cyan-300"
                >
                  {selectedTrackKey === track.key ? 'Hide topic history' : 'View topic history'}
                </button>
                {selectedTrackKey === track.key && (() => {
                  const evidence = getTrackEvidence(track);
                  return (
                    <div className="mt-3 p-3 rounded-lg bg-slate-950/70 border border-slate-800 space-y-2">
                      <p className="text-[10px] text-slate-500">
                        Recorded learning evidence, not reconstructed historical mastery scores. {evidence.distinctProblems.size} distinct problem(s) have explicit outcomes.
                      </p>
                      <div className="flex flex-wrap gap-3 text-[10px]">
                        <span className="text-emerald-300">{evidence.independent.size} independent</span>
                        <span className="text-amber-300">{evidence.hints.size} with hints</span>
                        <span className="text-rose-300">{evidence.editorials.size} editorial-dependent</span>
                      </div>
                      {evidence.latestEvents.length === 0 ? (
                        <p className="text-[11px] text-slate-500">No recent journal records for this track.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {evidence.latestEvents.map((event) => (
                            <li key={event.id} className="text-[10px] text-slate-400">
                              <span className="text-slate-200">{event.problemName}</span>
                              {' · '}{new Date(event.occurredAt).toLocaleDateString()}
                              {' · '}{event.solvedStatus?.replace(/_/g, ' ') || event.solutionMethod?.replace(/_/g, ' ') || (event.verifiedAc ? 'Verified AC' : 'Encounter')}
                              {event.struggleReason && <span className="text-amber-400"> · {event.struggleReason.toLowerCase().replace(/_/g, ' ')}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Actionable Next Step Recommendation */}
              <div className="pt-2 border-t border-slate-800/80">
                <div className="text-xs font-semibold text-indigo-300 flex items-center gap-1.5 mb-1">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                  Recommended Action:
                </div>
                <p className="text-xs text-slate-300 line-clamp-2">
                  {track.recommendedNextStep}
                </p>

                {/* Tags */}
                <div className="flex flex-wrap gap-1 mt-2.5">
                  {track.tags.map((t) => (
                    <span key={t} className="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400">
                      #{t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
