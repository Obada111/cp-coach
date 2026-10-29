import { randomUUID } from 'node:crypto';
import { db, getProfileById } from './db.js';

export type ProblemLearningSource =
  | 'DAILY_ENCOUNTER'
  | 'DAILY_FEEDBACK'
  | 'VERIFIED_CODEFORCES'
  | 'CONTEST_REVIEW'
  | 'SOLVE_SESSION';

export interface ProblemLearningEventInput {
  profileId: string;
  problemId: string;
  source: ProblemLearningSource;
  solvedStatus?: string | null;
  perceivedDifficulty?: string | null;
  difficultyExperience?: string | null;
  solutionMethod?: string | null;
  struggleReason?: string | null;
  notes?: string | null;
  problemOpinion?: string | null;
  verifiedAc?: boolean;
  hintsRevealed?: number | null;
  editorialViewed?: boolean | null;
  sourceKey?: string | null;
  problemName?: string | null;
  contestId?: number | null;
  problemIndex?: string | null;
  rating?: number | null;
  tags?: string[];
}

export interface ProblemLearningEvent {
  id: string;
  profileId: string;
  problemId: string;
  source: ProblemLearningSource;
  problemName: string;
  contestId: number | null;
  problemIndex: string | null;
  rating: number | null;
  tags: string[];
  solvedStatus: string | null;
  perceivedDifficulty: string | null;
  difficultyExperience: string | null;
  solutionMethod: string | null;
  struggleReason: string | null;
  notes: string | null;
  problemOpinion: string | null;
  verifiedAc: boolean;
  hintsRevealed: number | null;
  editorialViewed: boolean | null;
  occurredAt: string;
}

function parseTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export class ProblemJournalService {
  record(input: ProblemLearningEventInput): void {
    if (!getProfileById(input.profileId)) {
      throw new Error(`Profile '${input.profileId}' not found`);
    }

    const parts = input.problemId.split('_');
    const parsedContestId = Number(parts[0]);
    const requestedContestId = input.contestId ?? (Number.isInteger(parsedContestId) ? parsedContestId : null);
    const requestedProblemIndex = input.problemIndex ?? (parts.slice(1).join('_') || null);

    const problem = db.prepare(`
      SELECT p.name, p.contest_id, p.problem_index, p.rating, p.tags,
             m.name AS meta_name, m.rating AS meta_rating, m.tags AS meta_tags
      FROM problems p
      LEFT JOIN contest_problems_meta m
        ON m.contest_id = p.contest_id AND m.problem_index = p.problem_index
      WHERE p.id = ?
    `).get(input.problemId) as {
      name: string;
      contest_id: number;
      problem_index: string;
      rating: number | null;
      tags: string;
      meta_name: string | null;
      meta_rating: number | null;
      meta_tags: string | null;
    } | undefined;

    const contestMetadata = !problem && requestedContestId !== null && requestedProblemIndex
      ? db.prepare(`
          SELECT name, rating, tags
          FROM contest_problems_meta
          WHERE contest_id = ? AND problem_index = ?
        `).get(requestedContestId, requestedProblemIndex) as {
          name: string;
          rating: number | null;
          tags: string;
        } | undefined
      : undefined;

    const contestId = input.contestId ?? problem?.contest_id ?? (Number.isInteger(parsedContestId) ? parsedContestId : null);
    const problemIndex = input.problemIndex ?? problem?.problem_index ?? requestedProblemIndex;
    const problemName = input.problemName ?? problem?.name ?? problem?.meta_name ?? contestMetadata?.name ?? `Problem ${input.problemId}`;
    const rating = input.rating ?? problem?.rating ?? problem?.meta_rating ?? contestMetadata?.rating ?? null;
    const tags = input.tags
      ? JSON.stringify(input.tags)
      : (problem?.tags || problem?.meta_tags || contestMetadata?.tags || '[]');

    db.prepare(`
      INSERT OR IGNORE INTO problem_learning_events (
        id, profile_id, problem_id, source, problem_name, contest_id, problem_index,
        rating, tags, solved_status, perceived_difficulty, difficulty_experience,
        solution_method, struggle_reason, notes, problem_opinion,
        verified_ac, hints_revealed, editorial_viewed, source_key, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      randomUUID(),
      input.profileId,
      input.problemId,
      input.source,
      problemName,
      contestId,
      problemIndex,
      rating,
      tags,
      input.solvedStatus ?? null,
      input.perceivedDifficulty ?? null,
      input.difficultyExperience ?? null,
      input.solutionMethod ?? null,
      input.struggleReason ?? null,
      input.notes ?? null,
      input.problemOpinion ?? null,
      input.verifiedAc ? 1 : 0,
      input.hintsRevealed ?? null,
      input.editorialViewed == null ? null : (input.editorialViewed ? 1 : 0),
      input.sourceKey ?? null
    );
  }

  getForProfile(profileId: string, limit = 100): ProblemLearningEvent[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = db.prepare(`
      SELECT * FROM problem_learning_events
      WHERE profile_id = ?
      ORDER BY occurred_at DESC, rowid DESC
      LIMIT ?
    `).all(profileId, safeLimit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      profileId: String(row.profile_id),
      problemId: String(row.problem_id),
      source: row.source as ProblemLearningSource,
      problemName: String(row.problem_name || row.problem_id),
      contestId: typeof row.contest_id === 'number' ? row.contest_id : null,
      problemIndex: typeof row.problem_index === 'string' ? row.problem_index : null,
      rating: typeof row.rating === 'number' ? row.rating : null,
      tags: parseTags(row.tags),
      solvedStatus: typeof row.solved_status === 'string' ? row.solved_status : null,
      perceivedDifficulty: typeof row.perceived_difficulty === 'string' ? row.perceived_difficulty : null,
      difficultyExperience: typeof row.difficulty_experience === 'string' ? row.difficulty_experience : null,
      solutionMethod: typeof row.solution_method === 'string' ? row.solution_method : null,
      struggleReason: typeof row.struggle_reason === 'string' ? row.struggle_reason : null,
      notes: typeof row.notes === 'string' ? row.notes : null,
      problemOpinion: typeof row.problem_opinion === 'string' ? row.problem_opinion : null,
      verifiedAc: row.verified_ac === 1,
      hintsRevealed: typeof row.hints_revealed === 'number' ? row.hints_revealed : null,
      editorialViewed: typeof row.editorial_viewed === 'number' ? row.editorial_viewed === 1 : null,
      occurredAt: String(row.occurred_at),
    }));
  }
}

export const problemJournalService = new ProblemJournalService();
