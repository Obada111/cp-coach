import React, { Suspense, lazy } from 'react';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  Compass,
  Flame,
  Lightbulb,
  RotateCcw,
  Sparkles,
  Target,
  Trophy,
  TrendingUp,
} from 'lucide-react';
import type { DashboardOverview, ReviewQueueItem, WeeklyGoal } from '../types';
import { getRankColor } from '../utils';
import type { AppTab } from './AppNavigation';

const LazyRatingChart = lazy(() =>
  import('./RatingChart').then((module) => ({ default: module.RatingChart })),
);

interface UpcomingContest {
  id: number;
  name: string;
  startTimeSeconds: number;
  durationSeconds: number;
  phase: string;
  url: string;
}

interface DashboardHomeProps {
  data: DashboardOverview;
  weeklyGoal: WeeklyGoal | null;
  dueReviews: ReviewQueueItem[];
  dueCount: number;
  upcomingContests: UpcomingContest[];
  isSyncing: boolean;
  formatContestCountdown: (startTimeSeconds: number) => string;
  onNavigate: (tab: AppTab) => void;
  onSync: () => void;
}

const progressPercent = (current: number, target: number) =>
  target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

export const DashboardHome: React.FC<DashboardHomeProps> = ({
  data,
  weeklyGoal,
  dueReviews,
  dueCount,
  upcomingContests,
  isSyncing,
  formatContestCountdown,
  onNavigate,
  onSync,
}) => {
  const { user, todaySet } = data;
  const completed = todaySet?.completionProgress.completed ?? 0;
  const total = todaySet?.completionProgress.total ?? 0;
  const dailyProgress = total > 0 ? Math.round((completed / total) * 100) : 0;
  const orderedRatings = [...data.ratingHistory].sort(
    (left, right) => left.ratingUpdateTimeSeconds - right.ratingUpdateTimeSeconds,
  );
  const latestRatingChange = orderedRatings.length > 1
    ? orderedRatings[orderedRatings.length - 1].newRating -
      orderedRatings[orderedRatings.length - 2].newRating
    : null;
  const firstName = data.activeProfile.displayName.trim() || data.activeProfile.handle;
  const dayPart = new Date().getHours();
  const greetingText = dayPart < 12 ? 'Good morning' : dayPart < 18 ? 'Good afternoon' : 'Good evening';
  const primaryWeakness = data.topics.weak.slice(0, 3);
  const duePreview = dueReviews.slice(0, 3);
  const contest = upcomingContests[0];

  return (
    <div className="space-y-7">
      <section className="flex flex-col gap-5 rounded-3xl border border-slate-800 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-cyan-950/55 via-slate-900 to-slate-950 p-5 shadow-xl shadow-black/10 sm:p-7 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
            <Sparkles className="h-4 w-4" />
            Your training workspace
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {greetingText}, {firstName}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
            A clear view of your practice, progress, and what to focus on next.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${data.syncStatus.error ? 'bg-amber-400' : 'bg-emerald-400'}`} />
              {data.syncStatus.error ? 'Showing cached Codeforces data' : `Codeforces · ${data.activeProfile.handle}`}
            </span>
            {user?.rank && (
              <span className={`font-medium capitalize ${getRankColor(user.rating, user.rank)}`}>
                {user.rank}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onNavigate('training')}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          >
            <Sparkles className="h-4 w-4" />
            {completed > 0 ? 'Continue training' : 'Start training'}
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onSync}
            disabled={isSyncing}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
          >
            <TrendingUp className={`h-4 w-4 text-cyan-300 ${isSyncing ? 'animate-pulse' : ''}`} />
            {isSyncing ? 'Syncing…' : 'Sync Codeforces'}
          </button>
        </div>
      </section>

      {data.syncStatus.error && (
        <div role="status" className="flex flex-col gap-3 rounded-2xl border border-amber-800/50 bg-amber-950/25 p-4 text-sm text-amber-200 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            Codeforces refresh failed. Your saved recommendations and analytics are still available.
          </span>
          <button type="button" onClick={onSync} disabled={isSyncing} className="shrink-0 rounded-lg border border-amber-700/60 px-3 py-2 text-xs font-semibold hover:bg-amber-900/40 disabled:opacity-50">
            Try again
          </button>
        </div>
      )}

      <section aria-label="Training summary" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Current rating"
          value={user?.rating?.toLocaleString() ?? 'Unrated'}
          detail={user?.maxRating ? `Peak ${user.maxRating.toLocaleString()}` : 'Codeforces rating'}
          color="cyan"
          trend={latestRatingChange}
        />
        <MetricCard
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Problems solved"
          value={data.distinctSolvedCount.toLocaleString()}
          detail="Distinct accepted problems"
          color="emerald"
        />
        <MetricCard
          icon={<Flame className="h-4 w-4" />}
          label="Practice streak"
          value={`${data.streakDays}`}
          detail={data.streakDays === 1 ? 'day in a row' : 'days in a row'}
          color="amber"
        />
        <MetricCard
          icon={<Target className="h-4 w-4" />}
          label="Today's plan"
          value={total > 0 ? `${completed} / ${total}` : 'Not ready'}
          detail={total > 0 ? `${dailyProgress}% complete` : 'Recommendations unavailable'}
          color="violet"
        />
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.85fr)]">
        <section className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/65 p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">Today</p>
              <h2 className="mt-1 text-lg font-bold text-white">Recommended practice</h2>
              <p className="mt-1 text-xs text-slate-500">
                Personalized from your Codeforces history and training feedback.
              </p>
            </div>
            <button type="button" onClick={() => onNavigate('training')} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200">
              Open plan <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {todaySet?.problems.length ? (
            <div className="space-y-2.5">
              {todaySet.problems.map((problem) => (
                <a
                  key={problem.id}
                  href={problem.problem ? `https://codeforces.com/problemset/problem/${problem.problem.contestId}/${problem.problem.index}` : undefined}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    if (!problem.problem) {
                      event.preventDefault();
                      onNavigate('training');
                    }
                  }}
                  className="group flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/65 p-3 transition hover:border-slate-700 hover:bg-slate-950"
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                    problem.category === 'WEAKNESS_DRILL'
                      ? 'bg-rose-400/10 text-rose-300'
                      : problem.category === 'CHALLENGE'
                        ? 'bg-violet-400/10 text-violet-300'
                        : 'bg-amber-400/10 text-amber-300'
                  }`}>
                    {problem.problem?.index ?? 'CF'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-100 group-hover:text-white">
                      {problem.problem?.name ?? problem.problemId}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {categoryLabel(problem.category)}
                      {problem.problem?.tags?.length ? ` · ${problem.problem.tags.slice(0, 2).join(', ')}` : ''}
                    </span>
                  </span>
                  {problem.problem?.rating && (
                    <span className="shrink-0 rounded-md bg-slate-800 px-2 py-1 text-xs font-semibold tabular-nums text-slate-300">
                      {problem.problem.rating}
                    </span>
                  )}
                  {problem.completed && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />}
                  <ArrowRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-slate-300" />
                </a>
              ))}
              <div className="pt-1">
                <div className="mb-2 flex justify-between text-xs">
                  <span className="text-slate-400">Plan progress</span>
                  <span className="font-semibold tabular-nums text-slate-200">{completed} of {total} complete</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all" style={{ width: `${dailyProgress}%` }} />
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<Sparkles className="h-5 w-5" />}
              title={data.syncStatus.isSyncing ? 'Preparing your recommendations' : 'No recommendations yet'}
              detail={data.syncStatus.isSyncing
                ? 'Your training plan will appear when Codeforces data is ready.'
                : 'Sync Codeforces to build a personalized daily plan.'}
              action={data.syncStatus.isSyncing ? undefined : { label: 'Sync Codeforces', onClick: onSync }}
            />
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-300">This week</p>
              <h2 className="mt-1 text-lg font-bold text-white">Your goal</h2>
            </div>
            <Target className="h-5 w-5 text-violet-300" />
          </div>
          {weeklyGoal ? (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-200">Problems solved</span>
                  <span className="text-sm font-bold tabular-nums text-white">
                    {weeklyGoal.actualSolvesCount}
                    <span className="font-medium text-slate-500"> / {weeklyGoal.targetSolvesCount}</span>
                  </span>
                </div>
                <ProgressBar value={progressPercent(weeklyGoal.actualSolvesCount, weeklyGoal.targetSolvesCount)} color="cyan" />
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-200">Contests</span>
                  <span className="text-sm font-bold tabular-nums text-white">
                    {weeklyGoal.actualContestsCount}
                    <span className="font-medium text-slate-500"> / {weeklyGoal.targetContestsCount}</span>
                  </span>
                </div>
                <ProgressBar value={progressPercent(weeklyGoal.actualContestsCount, weeklyGoal.targetContestsCount)} color="violet" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4 text-xs">
                <span className="text-slate-500">Week of {weeklyGoal.weekStartDate}</span>
                {weeklyGoal.focusTopic && (
                  <span className="rounded-full bg-slate-800 px-2.5 py-1 text-slate-300">{weeklyGoal.focusTopic}</span>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<Target className="h-5 w-5" />}
              title="Weekly goal unavailable"
              detail="Your goal data could not be loaded. Refresh the dashboard to try again."
            />
          )}
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-300">Personalized insights</p>
              <h2 className="mt-1 text-lg font-bold text-white">Topics to strengthen</h2>
            </div>
            <button type="button" onClick={() => onNavigate('topics')} className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200">
              All topics <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {primaryWeakness.length ? (
            <div className="space-y-3">
              {primaryWeakness.map((topic) => (
                <div key={topic.tag} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-semibold capitalize text-slate-100">{topic.displayName || topic.tag}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">
                      {topic.solvedCount}/{topic.attemptsCount} solved
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-rose-400" style={{ width: `${Math.min(100, Math.max(0, topic.solveRate))}%` }} />
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{topic.recommendedNextStep || topic.explanation}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Lightbulb className="h-5 w-5" />}
              title={data.topics.all.length ? 'No confirmed weak topics' : 'Topic insights need more data'}
              detail={data.topics.all.length
                ? 'Current evidence does not classify a topic as weak. Unexplored topics remain separate from weaknesses.'
                : 'Sync your Codeforces history to see evidence-based topic analysis.'}
              action={!data.topics.all.length ? { label: 'Sync Codeforces', onClick: onSync } : undefined}
            />
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-300">Keep concepts fresh</p>
              <h2 className="mt-1 text-lg font-bold text-white">Reviews due</h2>
            </div>
            <button type="button" onClick={() => onNavigate('reviews')} className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 hover:text-cyan-200">
              Review queue <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {dueCount > 0 && duePreview.length > 0 ? (
            <div className="space-y-2.5">
              {duePreview.map((review) => (
                <div key={review.id} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-400/10 text-amber-300">
                    <RotateCcw className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-100">{review.problemName}</span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {review.tags.slice(0, 2).join(', ') || review.triggerReason}
                    </span>
                  </span>
                  {review.rating && <span className="text-xs tabular-nums text-slate-400">{review.rating}</span>}
                </div>
              ))}
              {dueCount > duePreview.length && (
                <p className="px-1 pt-1 text-xs text-slate-500">
                  +{dueCount - duePreview.length} more in your review queue
                </p>
              )}
            </div>
          ) : dueCount > 0 ? (
            <EmptyState
              icon={<RotateCcw className="h-5 w-5" />}
              title={`${dueCount} ${dueCount === 1 ? 'review is' : 'reviews are'} due`}
              detail="Open your review queue to load the problem details and record an outcome."
              action={{ label: 'Open review queue', onClick: () => onNavigate('reviews') }}
            />
          ) : (
            <EmptyState
              icon={<CheckCircle2 className="h-5 w-5" />}
              title="You're up to date"
              detail="There are no problems due for review right now."
              action={{ label: 'Open review queue', onClick: () => onNavigate('reviews') }}
            />
          )}
        </section>
      </div>

      {data.learnerModel?.coachInsight && (
        <section className="flex items-start gap-3 rounded-2xl border border-cyan-900/50 bg-cyan-950/20 p-4 sm:p-5">
          <span className="rounded-xl bg-cyan-400/10 p-2 text-cyan-300"><Lightbulb className="h-5 w-5" /></span>
          <div>
            <h2 className="text-sm font-bold text-cyan-100">Coach insight</h2>
            <p className="mt-1 text-sm leading-6 text-slate-300">{data.learnerModel.coachInsight}</p>
          </div>
        </section>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
        <section className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/65 p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">Performance</p>
              <h2 className="mt-1 text-lg font-bold text-white">Codeforces rating</h2>
            </div>
            {latestRatingChange !== null && (
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                latestRatingChange > 0
                  ? 'bg-emerald-400/10 text-emerald-300'
                  : latestRatingChange < 0
                    ? 'bg-rose-400/10 text-rose-300'
                    : 'bg-slate-800 text-slate-300'
              }`}>
                {latestRatingChange > 0
                  ? <ArrowUpRight className="h-3.5 w-3.5" />
                  : latestRatingChange < 0
                    ? <ArrowDownRight className="h-3.5 w-3.5" />
                    : null}
                {latestRatingChange > 0 ? '+' : ''}{latestRatingChange} since prior contest
              </span>
            )}
          </div>
          {orderedRatings.length ? (
            <Suspense fallback={<div role="status" className="h-56 animate-pulse rounded-xl bg-slate-950/60" />}>
              <LazyRatingChart ratingHistory={orderedRatings} currentRating={user?.rating} />
            </Suspense>
          ) : (
            <EmptyState
              icon={<TrendingUp className="h-5 w-5" />}
              title="No rating history yet"
              detail="A rating chart will appear after Codeforces records are synchronized."
            />
          )}
        </section>

        <div className="min-w-0 space-y-6">
          {contest && (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-5">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-violet-400/10 p-2 text-violet-300"><Trophy className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-300">Up next</p>
                  <h2 className="mt-1 truncate text-sm font-bold text-white">{contest.name}</h2>
                  <p className="mt-1 text-xs text-slate-400">
                    {formatContestCountdown(contest.startTimeSeconds)}
                  </p>
                </div>
              </div>
              <a href={contest.url} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-300 hover:text-cyan-200">
                Contest details <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </section>
          )}

          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-5">
            <h2 className="text-sm font-bold text-white">Pick up where you left off</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <QuickLink icon={<RotateCcw className="h-4 w-4" />} label="Reviews" onClick={() => onNavigate('reviews')} />
              <QuickLink icon={<Compass className="h-4 w-4" />} label="Mastery map" onClick={() => onNavigate('skill-tracks')} />
              <QuickLink icon={<BookOpen className="h-4 w-4" />} label="Journal" onClick={() => onNavigate('journal')} />
              <QuickLink icon={<Clock3 className="h-4 w-4" />} label="History" onClick={() => onNavigate('history')} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

const categoryLabel = (category: string) => {
  if (category === 'WEAKNESS_DRILL') return 'Weakness drill';
  if (category === 'CHALLENGE') return 'Stretch challenge';
  return 'Reinforcement';
};

const MetricCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  color: 'cyan' | 'emerald' | 'amber' | 'violet';
  trend?: number | null;
}> = ({ icon, label, value, detail, color, trend }) => {
  const accent = {
    cyan: 'bg-cyan-400/10 text-cyan-300',
    emerald: 'bg-emerald-400/10 text-emerald-300',
    amber: 'bg-amber-400/10 text-amber-300',
    violet: 'bg-violet-400/10 text-violet-300',
  }[color];

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/65 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        <span className={`rounded-lg p-2 ${accent}`}>{icon}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xl font-bold tracking-tight text-white tabular-nums">{value}</span>
        {trend !== undefined && trend !== null && (
          <span className={`text-xs font-semibold ${trend >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            {trend > 0 ? '+' : ''}{trend}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
};

const ProgressBar: React.FC<{ value: number; color: 'cyan' | 'violet' }> = ({ value, color }) => (
  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
    <div
      className={`h-full rounded-full transition-all ${color === 'cyan' ? 'bg-cyan-400' : 'bg-violet-400'}`}
      style={{ width: `${value}%` }}
    />
  </div>
);

const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void };
}> = ({ icon, title, detail, action }) => (
  <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-950/35 px-5 py-6 text-center">
    <span className="mb-3 text-slate-500">{icon}</span>
    <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
    <p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">{detail}</p>
    {action && (
      <button type="button" onClick={action.onClick} className="mt-3 text-xs font-semibold text-cyan-300 hover:text-cyan-200">
        {action.label}
      </button>
    )}
  </div>
);

const QuickLink: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void }> = ({
  icon,
  label,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-left text-xs font-medium text-slate-300 transition hover:border-slate-700 hover:bg-slate-800/70 hover:text-white"
  >
    <span className="text-cyan-300">{icon}</span>
    {label}
  </button>
);
