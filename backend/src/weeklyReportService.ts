import { db, getProfileById } from './db.js';
import { analysisService } from './analysisService.js';

interface PeriodStats {
  attempted: number;
  solved: number;
  independentlySolved: number;
  requiredHints: number;
  requiredEditorial: number;
}

interface TopicPeriodStats {
  problems: Map<string, boolean>;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function dateTimeParts(value: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const values: Record<string, number> = {};
  for (const part of parts) values[part.type] = Number(part.value);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) => values[key] || 0);
}

export function localMidnightToUtcSeconds(date: string, timeZone = 'Asia/Hebron'): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('Report date must be a valid YYYY-MM-DD date');
  }
  const [year, month, day] = date.split('-').map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const [localYear, localMonth, localDay, hour, minute, second] = dateTimeParts(new Date(guess), timeZone);
    const localAsUtc = Date.UTC(localYear, localMonth - 1, localDay, hour, minute, second);
    const adjustment = targetAsUtc - localAsUtc;
    guess += adjustment;
    if (adjustment === 0) return Math.floor(guess / 1000);
  }
  throw new Error(`Could not resolve local midnight for ${date} in ${timeZone}`);
}

function emptyPeriod(): PeriodStats {
  return { attempted: 0, solved: 0, independentlySolved: 0, requiredHints: 0, requiredEditorial: 0 };
}

function submissionStats(handle: string, startSeconds: number, endSeconds: number): PeriodStats {
  const rows = db.prepare(`
    SELECT problem_id, verdict
    FROM submissions
    WHERE handle = ? AND creation_time >= ? AND creation_time < ?
  `).all(handle, startSeconds, endSeconds) as Array<{ problem_id: string; verdict: string | null }>;
  const problems = new Map<string, boolean>();
  for (const row of rows) {
    problems.set(row.problem_id, Boolean(problems.get(row.problem_id)) || row.verdict === 'OK');
  }
  const solved = Array.from(problems.values()).filter(Boolean).length;
  return { ...emptyPeriod(), attempted: problems.size, solved };
}

function readTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function addLearningEvidence(
  profileId: string,
  startSeconds: number,
  endSeconds: number
): {
  period: Pick<PeriodStats, 'independentlySolved' | 'requiredHints' | 'requiredEditorial'>;
  topics: Map<string, TopicPeriodStats>;
  mistakes: Map<string, Set<string>>;
} {
  const rows = db.prepare(`
    SELECT problem_id, tags, solved_status, solution_method, struggle_reason, verified_ac
    FROM problem_learning_events
    WHERE profile_id = ?
      AND julianday(occurred_at) >= julianday(?)
      AND julianday(occurred_at) < julianday(?)
    ORDER BY occurred_at DESC
  `).all(
    profileId,
    new Date(startSeconds * 1000).toISOString(),
    new Date(endSeconds * 1000).toISOString()
  ) as Array<{
    problem_id: string;
    tags: string;
    solved_status: string | null;
    solution_method: string | null;
    struggle_reason: string | null;
    verified_ac: number;
  }>;
  const evidenceByProblem = new Map<string, (typeof rows)>();
  const mistakes = new Map<string, Set<string>>();

  for (const row of rows) {
    if (row.solved_status || row.solution_method || row.verified_ac === 1) {
      const evidence = evidenceByProblem.get(row.problem_id) || [];
      evidence.push(row);
      evidenceByProblem.set(row.problem_id, evidence);
    }
    if (row.struggle_reason) {
      const problemIds = mistakes.get(row.struggle_reason) || new Set<string>();
      problemIds.add(row.problem_id);
      mistakes.set(row.struggle_reason, problemIds);
    }
  }

  const topics = new Map<string, TopicPeriodStats>();
  let independentlySolved = 0;
  let requiredHints = 0;
  let requiredEditorial = 0;
  for (const [problemId, evidence] of evidenceByProblem) {
    const independent = evidence.some((row) =>
      row.solved_status === 'SOLVED_INDEPENDENTLY' || row.solution_method === 'INDEPENDENT'
    );
    const withHints = evidence.some((row) =>
      row.solved_status === 'SOLVED_WITH_HINTS' || row.solution_method === 'HINTS'
    );
    const editorial = evidence.some((row) =>
      row.solved_status === 'VIEWED_EDITORIAL' || row.solution_method === 'EDITORIAL'
    );
    if (independent) independentlySolved++;
    if (withHints) requiredHints++;
    if (editorial) requiredEditorial++;

    const solvedIndependently = independent;
    for (const tag of new Set(evidence.flatMap((row) => readTags(row.tags)))) {
      const stats = topics.get(tag) || { problems: new Map<string, boolean>() };
      stats.problems.set(problemId, solvedIndependently);
      topics.set(tag, stats);
    }
  }
  return { period: { independentlySolved, requiredHints, requiredEditorial }, topics, mistakes };
}

function addPeriodData(handle: string, profileId: string, from: string, through: string) {
  const startSeconds = localMidnightToUtcSeconds(from);
  const endSeconds = localMidnightToUtcSeconds(shiftDate(through, 1));
  const submissions = submissionStats(handle, startSeconds, endSeconds);
  const learning = addLearningEvidence(profileId, startSeconds, endSeconds);
  return {
    summary: { ...submissions, ...learning.period },
    topics: learning.topics,
    mistakes: learning.mistakes,
  };
}

export class WeeklyReportService {
  getTodayDate(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(new Date());
  }

  getReport(profileId: string, referenceDate = this.getTodayDate()) {
    const profile = getProfileById(profileId);
    if (!profile) throw new Error(`Profile '${profileId}' not found`);
    localMidnightToUtcSeconds(referenceDate);

    const currentStart = shiftDate(referenceDate, -6);
    const previousEnd = shiftDate(currentStart, -1);
    const previousStart = shiftDate(previousEnd, -6);
    const current = addPeriodData(profile.handle, profileId, currentStart, referenceDate);
    const previous = addPeriodData(profile.handle, profileId, previousStart, previousEnd);
    const hasComparison = current.summary.attempted >= 3 && previous.summary.attempted >= 3;

    const topicImprovements = Array.from(current.topics.entries()).flatMap(([topic, stats]) => {
      const old = previous.topics.get(topic);
      if (!old || stats.problems.size < 3 || old.problems.size < 3) return [];
      const currentRate = Math.round(
        (Array.from(stats.problems.values()).filter(Boolean).length / stats.problems.size) * 100
      );
      const previousRate = Math.round(
        (Array.from(old.problems.values()).filter(Boolean).length / old.problems.size) * 100
      );
      const change = currentRate - previousRate;
      return change > 0
        ? [{ topic, currentRate, previousRate, change, evidence: `${stats.problems.size} current vs ${old.problems.size} previous problem records` }]
        : [];
    }).sort((a, b) => b.change - a.change).slice(0, 3);

    const practiceTopics = analysisService.analyzeTopics(
      profile.handle,
      profile.rating || 1300,
      profileId,
      referenceDate
    ).filter((topic) => topic.status === 'WEAK')
      .slice(0, 5)
      .map((topic) => ({ topic: topic.tag, explanation: topic.explanation }));

    const repeatedMistakes = Array.from(current.mistakes.entries())
      .filter(([, problemIds]) => problemIds.size >= 2)
      .map(([reason, problemIds]) => ({ reason, count: problemIds.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const priorities: string[] = [];
    if (practiceTopics.length > 0) priorities.push(`Practice ${practiceTopics[0].topic} with independent, rating-calibrated problems.`);
    if (repeatedMistakes.length > 0) priorities.push(`Review the recurring ${repeatedMistakes[0].reason.toLowerCase().replace(/_/g, ' ')} mistake before submitting.`);
    if (priorities.length === 0) {
      priorities.push(current.summary.attempted === 0
        ? 'Complete a few logged practice problems so the coach has recent evidence to guide next week.'
        : 'Maintain varied practice and record whether solutions were independent or assisted.');
    }

    return {
      generatedAt: new Date().toISOString(),
      currentPeriod: { from: currentStart, through: referenceDate, ...current.summary },
      previousPeriod: { from: previousStart, through: previousEnd, ...previous.summary },
      hasComparison,
      comparisonExplanation: hasComparison
        ? 'Compared distinct Codeforces problems attempted in two consecutive 7-day windows.'
        : 'At least three distinct Codeforces problems in each 7-day window are needed for a meaningful comparison.',
      topicImprovements,
      practiceTopics,
      repeatedMistakes,
      priorities,
    };
  }
}

export const weeklyReportService = new WeeklyReportService();
