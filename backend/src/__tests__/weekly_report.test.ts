import { beforeAll, describe, expect, it } from 'vitest';
import { db, getOrCreatePublicProfile, initDatabase } from '../db.js';
import { localMidnightToUtcSeconds, weeklyReportService } from '../weeklyReportService.js';

const CLIENT_ID = 'weekly-report-client';
const HANDLE = 'WeeklyReportUser';

function seconds(date: string): number {
  return Math.floor(Date.parse(date) / 1000);
}

function addProblem(problemId: string, contestId: number, index: string): void {
  db.prepare(`
    INSERT INTO problems (id, contest_id, problem_index, name, rating, tags)
    VALUES (?, ?, ?, ?, 1200, '["dp"]')
  `).run(problemId, contestId, index, `Problem ${index}`);
}

function addSubmission(
  id: number,
  problemId: string,
  contestId: number,
  index: string,
  date: string,
  verdict: string,
  handle = HANDLE
): void {
  db.prepare(`
    INSERT INTO submissions (id, handle, problem_id, contest_id, problem_index, verdict, creation_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, handle, problemId, contestId, index, verdict, seconds(date));
}

function addLearningEvent(
  profileId: string,
  id: string,
  problemId: string,
  occurredAt: string,
  status: string,
  struggleReason: string | null = null
): void {
  db.prepare(`
    INSERT INTO problem_learning_events (
      id, profile_id, problem_id, source, tags, solved_status,
      solution_method, struggle_reason, verified_ac, occurred_at
    ) VALUES (?, ?, ?, 'DAILY_FEEDBACK', '["dp"]', ?, ?, ?, 0, ?)
  `).run(id, profileId, problemId, status, status === 'SOLVED_INDEPENDENTLY' ? 'INDEPENDENT' : status, struggleReason, occurredAt);
}

function dateAfter(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function localDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hebron',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp * 1000));
  const fields = new Map(parts.map((part) => [part.type, part.value]));
  return `${fields.get('year')}-${fields.get('month')}-${fields.get('day')}`;
}

describe('weekly coach report', () => {
  let profileId: string;

  beforeAll(() => {
    initDatabase();
    profileId = getOrCreatePublicProfile(CLIENT_ID, HANDLE).id;
    const problems = [
      ['200_A', 200, 'A'],
      ['201_B', 201, 'B'],
      ['202_C', 202, 'C'],
      ['203_D', 203, 'D'],
      ['204_E', 204, 'E'],
      ['205_F', 205, 'F'],
    ] as const;
    problems.forEach(([problemId, contestId, index]) => addProblem(problemId, contestId, index));

    addSubmission(1, '200_A', 200, 'A', '2026-10-25T10:00:00.000Z', 'OK');
    addSubmission(2, '201_B', 201, 'B', '2026-10-26T10:00:00.000Z', 'WRONG_ANSWER');
    addSubmission(3, '202_C', 202, 'C', '2026-10-20T10:00:00.000Z', 'WRONG_ANSWER');
    addSubmission(4, '203_D', 203, 'D', '2026-10-21T10:00:00.000Z', 'WRONG_ANSWER');
    addSubmission(5, '204_E', 204, 'E', '2026-10-27T10:00:00.000Z', 'WRONG_ANSWER');
    addSubmission(6, '205_F', 205, 'F', '2026-10-22T10:00:00.000Z', 'WRONG_ANSWER');

    addLearningEvent(profileId, 'event-current-a', '200_A', '2026-10-25T10:00:00.000Z', 'SOLVED_INDEPENDENTLY', 'IMPLEMENTATION');
    addLearningEvent(profileId, 'event-current-b', '201_B', '2026-10-26T10:00:00.000Z', 'SOLVED_WITH_HINTS', 'IMPLEMENTATION');
    addLearningEvent(profileId, 'event-previous-c', '202_C', '2026-10-20T10:00:00.000Z', 'NOT_SOLVED');
    addLearningEvent(profileId, 'event-previous-d', '203_D', '2026-10-21T10:00:00.000Z', 'NOT_SOLVED');
    addLearningEvent(profileId, 'event-current-e', '204_E', '2026-10-27T10:00:00.000Z', 'NOT_SOLVED');
    addLearningEvent(profileId, 'event-previous-f', '205_F', '2026-10-22T10:00:00.000Z', 'NOT_SOLVED');
  });

  it('compares consecutive 7-day windows and requires evidence for topic improvement', () => {
    const report = weeklyReportService.getReport(profileId, '2026-10-30');
    expect(report.currentPeriod.from).toBe('2026-10-24');
    expect(report.currentPeriod.attempted).toBe(3);
    expect(report.currentPeriod.solved).toBe(1);
    expect(report.currentPeriod.independentlySolved).toBe(1);
    expect(report.currentPeriod.requiredHints).toBe(1);
    expect(report.hasComparison).toBe(true);
    expect(report.topicImprovements).toContainEqual(expect.objectContaining({
      topic: 'dp',
      previousRate: 0,
      currentRate: 33,
      change: 33,
    }));
    expect(report.repeatedMistakes).toContainEqual({ reason: 'IMPLEMENTATION', count: 2 });
  });

  it('does not present a comparison when the previous window has no attempts', () => {
    const report = weeklyReportService.getReport(profileId, '2026-11-10');
    expect(report.hasComparison).toBe(false);
    expect(report.comparisonExplanation).toContain('At least three distinct Codeforces problems');
  });

  it('uses Hebron local-midnight boundaries for submissions and learning events', () => {
    const handle = 'HebronBoundaryUser';
    const profile = getOrCreatePublicProfile('hebron-boundary-client', handle);
    const weekStart = '2026-10-24';
    const weekEnd = '2026-10-31';
    const start = localMidnightToUtcSeconds(weekStart);
    const end = localMidnightToUtcSeconds(weekEnd);
    const insideMidnight = localMidnightToUtcSeconds('2026-10-27');
    const events = [
      { id: 'outside-before-week', time: start - 1, included: false },
      { id: 'at-week-start', time: start, included: true },
      { id: 'before-local-midnight', time: insideMidnight - 1, included: true },
      { id: 'after-local-midnight', time: insideMidnight, included: true },
      { id: 'before-week-end', time: end - 1, included: true },
      { id: 'at-week-end', time: end, included: false },
    ];

    expect(localDate(start - 1)).toBe('2026-10-23');
    expect(localDate(start)).toBe(weekStart);
    expect(localDate(insideMidnight - 1)).toBe('2026-10-26');
    expect(localDate(insideMidnight)).toBe('2026-10-27');
    expect(localDate(end - 1)).toBe('2026-10-30');
    expect(localDate(end)).toBe(weekEnd);

    events.forEach((event, index) => {
      const problemId = `boundary-${index}`;
      const contestId = 300 + index;
      addProblem(problemId, contestId, 'A');
      const occurredAt = new Date(event.time * 1000).toISOString();
      addSubmission(1001 + index, problemId, contestId, 'A', occurredAt, 'OK', handle);
      addLearningEvent(profile.id, event.id, problemId, occurredAt, 'SOLVED_INDEPENDENTLY');
    });

    const report = weeklyReportService.getReport(profile.id, '2026-10-30');
    expect(events.filter((event) => event.included)).toHaveLength(4);
    expect(report.currentPeriod.attempted).toBe(4);
    expect(report.currentPeriod.solved).toBe(4);
    expect(report.currentPeriod.independentlySolved).toBe(4);
  });

  it('resolves weekly boundaries across actual Asia/Hebron UTC-offset transitions', () => {
    const dates = Array.from({ length: 366 }, (_, index) => dateAfter('2026-01-01', index));
    const transitions = dates.slice(1).flatMap((date, index) => {
      const previous = dates[index];
      const duration = localMidnightToUtcSeconds(date) - localMidnightToUtcSeconds(previous);
      return duration === 23 * 3600 || duration === 25 * 3600 ? [{ date, duration }] : [];
    });
    expect(transitions.length).toBeGreaterThan(0);

    const handle = 'HebronTransitionUser';
    const profile = getOrCreatePublicProfile('hebron-transition-client', handle);
    for (const [index, transition] of transitions.entries()) {
      const boundary = localMidnightToUtcSeconds(transition.date);
      expect(localDate(boundary)).toBe(transition.date);
      expect(localDate(boundary - 1)).toBe(dateAfter(transition.date, -1));
      if (index > 0) continue;

      for (const [eventIndex, time] of [boundary - 1, boundary].entries()) {
        const problemId = `dst-boundary-${eventIndex}`;
        const contestId = 400 + eventIndex;
        const occurredAt = new Date(time * 1000).toISOString();
        addProblem(problemId, contestId, 'A');
        addSubmission(2001 + eventIndex, problemId, contestId, 'A', occurredAt, 'OK', handle);
        addLearningEvent(profile.id, `dst-event-${eventIndex}`, problemId, occurredAt, 'SOLVED_INDEPENDENTLY');
      }

      const report = weeklyReportService.getReport(profile.id, transition.date);
      expect(report.currentPeriod.attempted).toBe(2);
      expect(report.currentPeriod.independentlySolved).toBe(2);
    }
  });
});
