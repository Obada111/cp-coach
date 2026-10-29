import React, { useState } from 'react';
import { 
  AlertTriangle, 
  CheckCircle2, 
  HelpCircle, 
  Search, 
  Info
} from 'lucide-react';
import { TopicAnalysis } from '../types';

interface TopicAnalysisViewProps {
  topics: {
    weak: TopicAnalysis[];
    strong: TopicAnalysis[];
    unexplored: TopicAnalysis[];
    all: TopicAnalysis[];
  };
}

export const TopicAnalysisView: React.FC<TopicAnalysisViewProps> = ({ topics }) => {
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'WEAK' | 'STRONG' | 'UNEXPLORED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTopics = topics.all.filter((t) => {
    if (activeFilter === 'WEAK' && t.status !== 'WEAK') return false;
    if (activeFilter === 'STRONG' && t.status !== 'STRONG') return false;
    if (activeFilter === 'UNEXPLORED' && t.status !== 'UNEXPLORED') return false;
    if (searchQuery.trim()) {
      return t.tag.toLowerCase().includes(searchQuery.toLowerCase());
    }
    return true;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'WEAK':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-950/70 border border-rose-800 text-rose-300">
            <AlertTriangle className="w-3 h-3 text-rose-400" />
            Demonstrated Weakness
          </span>
        );
      case 'STRONG':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-950/70 border border-emerald-800 text-emerald-300">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            Demonstrated Strength
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-850 border border-slate-700 text-slate-400">
            <HelpCircle className="w-3 h-3 text-slate-400" />
            Unexplored / Low Data
          </span>
        );
    }
  };

  const getConfidenceBadge = (confidence: string) => {
    switch (confidence) {
      case 'HIGH':
        return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800/60">High Evidence (≥10)</span>;
      case 'MEDIUM':
        return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/60">Medium Evidence (≥5)</span>;
      default:
        return <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">Low Evidence (&lt;5)</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Weak topics card */}
        <div 
          onClick={() => setActiveFilter('WEAK')}
          className={`p-4 rounded-xl border cursor-pointer transition-all ${
            activeFilter === 'WEAK' 
              ? 'bg-rose-950/40 border-rose-500/80 shadow-md shadow-rose-950/50' 
              : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-rose-300 uppercase tracking-wider">Demonstrated Weaknesses</span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <div className="text-2xl font-extrabold text-white mt-2">
            {topics.weak.length} <span className="text-xs text-rose-300 font-normal">topics</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Low solve rate or repeated Hard/Editorial marks with solid evidence.
          </p>
        </div>

        {/* Strong topics card */}
        <div 
          onClick={() => setActiveFilter('STRONG')}
          className={`p-4 rounded-xl border cursor-pointer transition-all ${
            activeFilter === 'STRONG' 
              ? 'bg-emerald-950/40 border-emerald-500/80 shadow-md shadow-emerald-950/50' 
              : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-300 uppercase tracking-wider">Demonstrated Strengths</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-extrabold text-white mt-2">
            {topics.strong.length} <span className="text-xs text-emerald-300 font-normal">topics</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Consistent high solve rate and confidence under contest conditions.
          </p>
        </div>

        {/* Unexplored card */}
        <div 
          onClick={() => setActiveFilter('UNEXPLORED')}
          className={`p-4 rounded-xl border cursor-pointer transition-all ${
            activeFilter === 'UNEXPLORED' 
              ? 'bg-slate-800 border-slate-600 shadow-md' 
              : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Unexplored / Insufficient Data</span>
            <HelpCircle className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-2xl font-extrabold text-white mt-2">
            {topics.unexplored.length} <span className="text-xs text-slate-400 font-normal">topics</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Fewer than 3 attempts. Not labeled as weak until evidence exists.
          </p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl bg-slate-900 border border-slate-800">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {(['ALL', 'WEAK', 'STRONG', 'UNEXPLORED'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                activeFilter === filter
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {filter === 'ALL' ? 'All Topics' : filter}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Search topic (e.g. dp, trees)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Topics List */}
      <div className="space-y-3">
        {filteredTopics.map((topic) => (
          <div
            key={topic.tag}
            className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-slate-700 transition-all space-y-3"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="text-sm font-bold text-white capitalize font-mono">
                  {topic.tag}
                </span>
                {getStatusBadge(topic.status)}
                {topic.masteryTier && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-950/80 text-indigo-300 border border-indigo-700/50">
                    {topic.masteryTier}
                  </span>
                )}
                {getConfidenceBadge(topic.confidence)}
                {topic.recentTrend && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    topic.recentTrend === 'IMPROVING'
                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/40'
                      : topic.recentTrend === 'DECLINING'
                      ? 'bg-rose-950/60 text-rose-300 border-rose-800/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}>
                    {topic.recentTrend === 'IMPROVING' ? '↗ Improving' : topic.recentTrend === 'DECLINING' ? '↘ Declining' : '→ Stable'}
                  </span>
                )}
              </div>

              {/* Solved stats & Mastery Score */}
              <div className="flex items-center gap-4 text-xs font-mono flex-wrap">
                <div>
                  <span className="text-slate-500">Solved: </span>
                  <span className="font-semibold text-slate-200">{topic.solvedCount}</span>
                  <span className="text-slate-500">/{topic.attemptsCount}</span>
                  <span className="ml-1 text-slate-400">({topic.solveRate}%)</span>
                </div>
                {topic.avgSolvedRating > 0 && (
                  <div>
                    <span className="text-slate-500">Avg Rating: </span>
                    <span className="font-semibold text-cyan-400">{topic.avgSolvedRating}</span>
                  </div>
                )}
                <div>
                  <span className="text-slate-500">Mastery Score: </span>
                  <span className="font-semibold text-emerald-400">
                    {topic.masteryScore ?? Math.max(0, 100 - topic.weaknessScore)}/100
                  </span>
                </div>
              </div>
            </div>

            {/* Progress bar visual for Mastery score */}
            <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  topic.status === 'STRONG'
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                    : topic.status === 'WEAK'
                    ? 'bg-gradient-to-r from-rose-500 to-amber-400'
                    : 'bg-gradient-to-r from-slate-600 to-slate-500'
                }`}
                style={{ width: `${Math.max(topic.masteryScore ?? topic.solveRate, 5)}%` }}
              />
            </div>

            {/* Explanation & Actionable Recommendation */}
            <div className="space-y-1.5 text-xs text-slate-300 bg-slate-950/60 p-3 rounded-lg border border-slate-850">
              <div className="flex items-start gap-2">
                <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                <p className="leading-relaxed text-slate-300">{topic.explanation}</p>
              </div>
              {topic.recommendedNextStep && (
                <div className="pt-1.5 border-t border-slate-800/80 text-[11px] text-indigo-300 flex items-start gap-1.5">
                  <span className="font-bold text-indigo-400">Next Action:</span>
                  <span>{topic.recommendedNextStep}</span>
                </div>
              )}
            </div>

            {/* Feedback badges if any */}
            {(topic.hardCount > 0 || topic.editorialOrHintsCount > 0 || topic.easyCount > 0) && (
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span>Personal Feedback:</span>
                {topic.hardCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800/40">
                    {topic.hardCount} marked Hard
                  </span>
                )}
                {topic.editorialOrHintsCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800/40">
                    {topic.editorialOrHintsCount} used Hints/Editorial
                  </span>
                )}
                {topic.easyCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/40">
                    {topic.easyCount} marked Easy
                  </span>
                )}
              </div>
            )}
          </div>
        ))}

        {filteredTopics.length === 0 && (
          <div className="p-8 text-center bg-slate-900 rounded-xl border border-slate-800 text-slate-500 text-xs">
            No topics matching the current filter.
          </div>
        )}
      </div>
    </div>
  );
};
