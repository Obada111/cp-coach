import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ClipboardList, Loader2, Minus } from 'lucide-react';
import { WeeklyCoachReport as Report } from '../types';
import { fetchWeeklyReport } from '../api';

interface Props {
  profileId: string;
}

export const WeeklyCoachReport: React.FC<Props> = ({ profileId }) => {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchWeeklyReport(profileId)
      .then((result) => { if (active) setReport(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load weekly report.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [profileId]);

  if (loading) {
    return <div className="mb-4 p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-400"><Loader2 className="inline w-4 h-4 mr-2 animate-spin text-cyan-400" />Preparing the last 7 days of training evidence...</div>;
  }
  if (error || !report) {
    return <div role="alert" className="mb-4 p-4 rounded-xl bg-rose-950/30 border border-rose-900/60 text-xs text-rose-300"><AlertCircle className="inline w-4 h-4 mr-2" />{error || 'Weekly report is unavailable.'}</div>;
  }

  const current = report.currentPeriod;
  const previous = report.previousPeriod;
  const metrics = [
    { label: 'Problems attempted', value: current.attempted, old: previous.attempted },
    { label: 'Problems solved', value: current.solved, old: previous.solved },
    { label: 'Solved independently', value: current.independentlySolved, old: previous.independentlySolved },
    { label: 'Needed hints', value: current.requiredHints, old: previous.requiredHints },
    { label: 'Needed editorial', value: current.requiredEditorial, old: previous.requiredEditorial },
  ];

  return (
    <section className="mb-4 p-4 rounded-xl bg-slate-900/95 border border-slate-700/80 space-y-4 shadow-md">
      <header className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <ClipboardList className="w-3.5 h-3.5 text-cyan-400" /> Weekly Coach Report
          </h3>
          <p className="text-[11px] text-slate-500 mt-1">
            {current.from} through {current.through} · compared with {previous.from} through {previous.through}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {metrics.map((metric) => {
          const delta = metric.value - metric.old;
          const Icon = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus;
          const color = metric.label.includes('hints') || metric.label.includes('editorial')
            ? delta < 0 ? 'text-emerald-400' : delta > 0 ? 'text-amber-400' : 'text-slate-500'
            : delta > 0 ? 'text-cyan-300' : delta < 0 ? 'text-amber-300' : 'text-slate-500';
          return (
            <div key={metric.label} className="p-3 rounded-lg bg-slate-950/70 border border-slate-800">
              <div className="text-[10px] text-slate-500">{metric.label}</div>
              <div className="flex items-baseline justify-between mt-1">
                <span className="text-lg font-bold text-white">{metric.value}</span>
                {report.hasComparison && (
                  <span className={`inline-flex items-center gap-0.5 text-[10px] ${color}`} title={`${metric.old} previous week`}>
                    <Icon className="w-3 h-3" />{Math.abs(delta)}
                  </span>
                )}
              </div>
              {report.hasComparison && <div className="text-[10px] text-slate-600">previous: {metric.old}</div>}
            </div>
          );
        })}
      </div>

      <p className={`text-[11px] ${report.hasComparison ? 'text-slate-500' : 'text-amber-300'}`}>
        {report.comparisonExplanation}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-900/40">
          <h4 className="text-xs font-semibold text-emerald-300 mb-1.5">Most improved topics</h4>
          {report.topicImprovements.length ? (
            <ul className="space-y-2">
              {report.topicImprovements.map((item) => (
                <li key={item.topic} className="text-[11px] text-slate-300">
                  <span className="font-semibold">{item.topic}</span>: {item.previousRate}% → {item.currentRate}% independent solve rate (+{item.change} points)
                  <span className="block text-slate-500">{item.evidence}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-[11px] text-slate-500">No topic has at least three recorded learning outcomes in both periods yet; no improvement claim is made.</p>}
        </div>

        <div className="p-3 rounded-lg bg-amber-950/20 border border-amber-900/40">
          <h4 className="text-xs font-semibold text-amber-300 mb-1.5">Practice priorities</h4>
          {report.practiceTopics.length ? (
            <ul className="space-y-1.5">
              {report.practiceTopics.slice(0, 3).map((topic) => (
                <li key={topic.topic} className="text-[11px] text-slate-300">
                  <span className="font-semibold">{topic.topic}</span> — {topic.explanation}
                </li>
              ))}
            </ul>
          ) : <p className="text-[11px] text-slate-500">No topic is currently classified weak by the evidence thresholds.</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800">
          <h4 className="text-xs font-semibold text-slate-200 mb-1.5">Repeated mistakes</h4>
          {report.repeatedMistakes.length
            ? report.repeatedMistakes.map((mistake) => (
              <p key={mistake.reason} className="text-[11px] text-slate-400">
                {mistake.reason.toLowerCase().replace(/_/g, ' ')} — recorded on {mistake.count} different problems
              </p>
            ))
            : <p className="text-[11px] text-slate-500">No repeated mistake has enough distinct-problem evidence this week.</p>}
        </div>
        <div className="p-3 rounded-lg bg-cyan-950/20 border border-cyan-900/40">
          <h4 className="text-xs font-semibold text-cyan-200 mb-1.5">Next-week plan</h4>
          <ul className="space-y-1">
            {report.priorities.map((priority) => <li key={priority} className="text-[11px] text-slate-300">{priority}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
};
