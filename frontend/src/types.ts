export interface CFUser {
  handle: string;
  rating?: number;
  maxRating?: number;
  rank?: string;
  maxRank?: string;
  avatar?: string;
  titlePhoto?: string;
  organization?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  country?: string;
  registrationTimeSeconds?: number;
  lastOnlineTimeSeconds?: number;
}

export interface CFRatingChange {
  contestId: number;
  contestName: string;
  handle: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
}

export interface CFProblem {
  contestId: number;
  index: string;
  name: string;
  type?: string;
  rating?: number;
  tags: string[];
  solvedCount?: number;
}

export interface UserProfile {
  id: string;
  handle: string;
  displayName: string;
  avatar?: string | null;
  rating?: number | null;
  maxRating?: number | null;
  rank?: string | null;
  maxRank?: string | null;
  isDefault: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export type ProblemSolvedStatus = 
  | 'SOLVED_INDEPENDENTLY' 
  | 'SOLVED_WITH_HINTS' 
  | 'VIEWED_EDITORIAL' 
  | 'NOT_SOLVED';

export type PerceivedDifficulty = 'EASY' | 'NORMAL' | 'HARD';

export type DifficultyExperience = 'MUCH_EASIER' | 'SLIGHTLY_EASY' | 'APPROPRIATE' | 'CHALLENGING' | 'MUCH_HARDER';
export type FeedbackSolutionMethod = 'INDEPENDENT' | 'HINTS' | 'EDITORIAL' | 'IDEA_IMPLEMENTATION' | 'NOT_SOLVED';
export type FeedbackStruggleReason = 'KEY_OBSERVATION' | 'ALGORITHM_CHOICE' | 'PROOF' | 'IMPLEMENTATION' | 'DEBUGGING' | 'EDGE_CASES';
export type ProblemOpinion = 'USEFUL_RELEVANT' | 'INTERESTING_TOO_EASY' | 'TOO_DIFFICULT' | 'REPETITIVE_FAMILIAR' | 'POOR_FIT';

export type DailyProblemCategory = 'WEAKNESS_DRILL' | 'REINFORCEMENT' | 'CHALLENGE';

export type EducationalSource = 
  | 'USACO_GUIDE' 
  | 'CSES' 
  | 'CODEFORCES_EDU' 
  | 'ATCODER_EDUCATIONAL_DP' 
  | 'CODEFORCES_PROBLEMSET';

export interface CurriculumProblem {
  id: string;
  problemId: string;
  source: EducationalSource;
  sourceUrl: string;
  name: string;
  curriculumStage: string;
  topic: string;
  targetRating: number;
  learningObjective: string;
  prerequisites: string[];
  cfContestId?: number;
  cfIndex?: string;
}

export interface DailyProblem {
  id: string;
  dailySetId: string;
  profileId: string;
  dailySetDate: string;
  problemId: string;
  category: DailyProblemCategory;
  reason: string;
  targetRating: number;
  completed: boolean;
  solvedStatus?: ProblemSolvedStatus | null;
  perceivedDifficulty?: PerceivedDifficulty | null;
  difficultyExperience?: DifficultyExperience | null;
  solutionMethod?: FeedbackSolutionMethod | null;
  timeSpentMinutes?: number | null;
  notes?: string | null;
  verifiedCfAc?: boolean;
  problem?: CFProblem;
  updatedAt?: string;

  // Educational source & pedagogical intent
  educationalSource?: EducationalSource;
  educationalSourceUrl?: string;
  curriculumStage?: string;
  learningObjective?: string;
  prerequisites?: string[];
  struggleReason?: string | null;
  problemOpinion?: ProblemOpinion | null;
  tutorial?: ProblemTutorial;

  // State model tracking
  isOpened?: boolean;
  openedAt?: string | null;
  attempted?: boolean;
  selfReportedSolved?: boolean;
  completionState?: 'NOT_OPENED' | 'OPENED' | 'ATTEMPTED' | 'SOLVED_SELF_REPORTED' | 'SOLVED_VERIFIED';
  syncPending?: boolean;
}

export interface ProblemTutorial {
  problemId: string;
  contestId?: number;
  problemIndex?: string;
  title: string;
  rating?: number | null;
  tags: string[];
  cfUrl: string;
  hint1: string;
  hint2: string;
  hint3: string;
  tutorial: {
    overview: string;
    keyInsights: string[];
    mathematicalProof?: string;
    algorithmSteps: string[];
    timeComplexity: string;
    spaceComplexity: string;
  };
  cppSolution: string;
  pythonSolution: string;
  takeaways: string[];
}

export interface DailySet {
  id: string;
  profileId: string;
  date: string;
  generatedAt: string;
  problems: DailyProblem[];
  completionProgress: {
    total: number;
    completed: number;
    verifiedCount: number;
    selfReportedCount: number;
    attemptedCount: number;
    openedCount: number;
    percentage: number;
  };
}

export interface ProblemLearningEvent {
  id: string;
  profileId: string;
  problemId: string;
  source: 'DAILY_ENCOUNTER' | 'DAILY_FEEDBACK' | 'VERIFIED_CODEFORCES' | 'CONTEST_REVIEW' | 'SOLVE_SESSION';
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

export type TopicConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type TopicStatus = 'WEAK' | 'STRONG' | 'UNEXPLORED';
export type MasteryTier = 'MASTERED' | 'PROFICIENT' | 'DEVELOPING' | 'EMERGING' | 'UNEXPLORED';

export interface TopicAnalysis {
  tag: string;
  displayName?: string;
  trackKey?: string;
  status: TopicStatus;
  confidence: TopicConfidence;
  masteryScore?: number; // 0 - 100 positive mastery
  masteryTier?: MasteryTier;
  attemptsCount: number;
  solvedCount: number;
  solveRate: number;
  avgSolvedRating: number;
  weaknessScore: number;
  editorialOrHintsCount: number;
  hardCount: number;
  easyCount: number;
  recentAttemptsCount?: number;
  recentSolvedCount?: number;
  recentTrend?: 'IMPROVING' | 'STABLE' | 'DECLINING';
  recommendedNextStep?: string;
  explanation: string;
}

export interface SkillTrack {
  key: string;
  name: string;
  description: string;
  tags: string[];
  masteryScore: number;
  masteryTier: MasteryTier;
  confidence: TopicConfidence;
  attemptsCount: number;
  solvedCount: number;
  solveRate: number;
  avgSolvedRating: number;
  recentAttemptsCount: number;
  recentSolvedCount: number;
  recentTrend: 'IMPROVING' | 'STABLE' | 'DECLINING';
  recommendedNextStep: string;
}

export interface TopicProficiencyState {
  tag: string;
  proficiencyScore: number;
  confidence: TopicConfidence;
  status: TopicStatus;
  attemptsCount: number;
  solvedCount: number;
  solveRate: number;
  recentTrend: 'IMPROVING' | 'STABLE' | 'DECLINING';
  lastPracticedDate?: string | null;
  reasons: string[];
}

export interface LearnerWeeklyReview {
  whatImproved: string[];
  difficultiesRemaining: string[];
  evidenceDetails: string[];
  trainingPrioritiesChanged: string[];
  planRationale: string;
  generatedAt: string;
}

export interface LearnerModel {
  profileId: string;
  handle: string;
  overallRating: number;
  independentSolveRate: number;
  hintDependenceRate: number;
  topicProficiencies: Record<string, TopicProficiencyState>;
  recentStruggles: string[];
  recentStrengths: string[];
  unexploredTopics: string[];
  coachInsight: string;
  weeklyReview: LearnerWeeklyReview;
  updatedAt: string;
}

export interface DataFreshness {
  submissionsLastRefreshed?: string | null;
  profileLastRefreshed?: string | null;
  ratingLastRefreshed?: string | null;
  contestsLastRefreshed?: string | null;
  problemsetLastRefreshed?: string | null;
  isSubmissionsStale?: boolean;
  isRatingStale?: boolean;
  isContestsStale?: boolean;
  isProblemsetStale?: boolean;
  isAnyStale?: boolean;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  isSyncing: boolean;
  handle: string;
  error?: string | null;
  submissionsCount: number;
  problemsCount: number;
  solvedDistinctCount: number;
  dataFreshness?: DataFreshness;
}

export interface DashboardOverview {
  activeProfile: UserProfile;
  availableProfiles: UserProfile[];
  user: CFUser | null;
  ratingHistory: CFRatingChange[];
  streakDays: number;
  distinctSolvedCount: number;
  topics: {
    weak: TopicAnalysis[];
    strong: TopicAnalysis[];
    unexplored: TopicAnalysis[];
    all: TopicAnalysis[];
  };
  todaySet: DailySet | null;
  syncStatus: SyncStatus;
  learnerModel?: LearnerModel;
}

export interface FeedbackPayload {
  solvedStatus: ProblemSolvedStatus;
  perceivedDifficulty?: PerceivedDifficulty | null;
  difficultyExperience?: DifficultyExperience | null;
  solutionMethod?: FeedbackSolutionMethod | null;
  timeSpentMinutes?: number | null;
  notes?: string | null;
  struggleReason?: string | null;
  problemOpinion?: ProblemOpinion | null;
}

export type ContestParticipationType = 'RATED' | 'VIRTUAL' | 'PRACTICE' | 'IMPORTED' | 'MISSED';
export type ContestInProblemStatus = 'SOLVED_IN_CONTEST' | 'ATTEMPTED_UNSOLVED' | 'NO_RECORDED_SUBMISSION';
export type ContestUpsolveStatus = 
  | 'IN_CONTEST_SOLVED' 
  | 'UPSOLVED_INDEPENDENTLY' 
  | 'UPSOLVED_WITH_HINTS' 
  | 'UPSOLVED_WITH_EDITORIAL' 
  | 'UNSOLVED';

export type SelfReviewTag = 
  | 'DID_NOT_RECOGNIZE_ALGORITHM'
  | 'STRUGGLED_WITH_IMPLEMENTATION'
  | 'BUG_DEBUGGING_DIFFICULTY'
  | 'RAN_OUT_OF_TIME'
  | 'CARELESS_MISTAKE'
  | 'SOLVED_DURING_UPSOLVING'
  | 'OTHER';

export interface ContestSubmissionItem {
  id: number;
  creationTimeSeconds: number;
  relativeTimeSeconds?: number;
  relativeTimeFormatted: string;
  problemIndex: string;
  verdict: string;
  passedTestCount?: number;
  timeConsumedMillis?: number;
  memoryConsumedBytes?: number;
  isAfterContest: boolean;
}

export interface ContestProblemAnalysis {
  index: string;
  name: string;
  rating?: number | null;
  tags: string[];
  cfUrl: string;
  status: ContestInProblemStatus;
  upsolveStatus: ContestUpsolveStatus;
  submissionsCount: number;
  unsuccessfulAttempts: number;
  firstAttemptRelativeSeconds?: number | null;
  firstAttemptFormatted?: string | null;
  solvedRelativeSeconds?: number | null;
  solvedFormatted?: string | null;
  timeSpentMinutes?: number | null;
  verdictSequence: string[];
  selfReviewTag?: SelfReviewTag | null;
  selfReviewNotes?: string | null;
  observations: string[];
  tutorial?: ProblemTutorial;
}

export interface VerdictBreakdown {
  ok: number;
  wrongAnswer: number;
  timeLimitExceeded: number;
  runtimeError: number;
  compilationError: number;
  memoryLimitExceeded: number;
  other: number;
}

export interface ContestTopicWeakness {
  tag: string;
  status: 'DEMONSTRATED_WEAKNESS' | 'POSSIBLE_WEAKNESS' | 'UNEXPLORED' | 'STRONG';
  contestAttempts: number;
  contestSolved: number;
  contestFailures: number;
  historicalAttempts: number;
  historicalSolveRate: number;
  reasons: string[];
  suggestedAction: string;
}

export interface ContestPostMortem {
  contestId: number;
  profileId: string;
  handle: string;
  name: string;
  startTimeSeconds: number;
  startTimeFormatted: string;
  durationSeconds: number;
  participationType: ContestParticipationType;
  rank?: number | null;
  oldRating?: number | null;
  newRating?: number | null;
  ratingChange?: number | null;
  problemsSolved: number;
  problemsAttempted: number;
  totalSubmissions: number;
  unsuccessfulAttempts: number;
  penalties: number;
  performanceVsHistorical: string;
  isStandingsConfirmed: boolean;
  problems: ContestProblemAnalysis[];
  verdictBreakdown: VerdictBreakdown;
  verdictPatterns: string[];
  strategyObservations: string[];
  timeline: ContestSubmissionItem[];
  topicWeaknesses: ContestTopicWeakness[];
  upsolvingSummary: {
    inContestSolved: number;
    upsolvedCount: number;
    unsolvedCount: number;
  };
}

export interface UserContestSummary {
  id: string;
  profileId: string;
  contestId: number;
  name: string;
  division?: string;
  participated?: boolean;
  startTimeSeconds: number;
  startTimeFormatted: string;
  durationSeconds: number;
  participationType: ContestParticipationType;
  rank?: number | null;
  oldRating?: number | null;
  newRating?: number | null;
  ratingChange?: number | null;
  problemsSolved: number;
  problemsAttempted: number;
  totalSubmissions: number;
  isOfficial: boolean;
  updatedAt: string;
}

export type ReviewSource = 'DAILY_STRUGGLE' | 'CONTEST_STRUGGLE' | 'MANUAL';
export type ReviewState = 'DUE' | 'COMPLETED' | 'DEFERRED' | 'MASTERED';
export type ReviewOutcome = 'MASTERED' | 'EASY' | 'DIFFICULT' | 'DEFERRED';

export interface ReviewQueueItem {
  id: string;
  profileId: string;
  problemId: string;
  source: ReviewSource;
  contestId: number | null;
  problemIndex: string | null;
  problemName: string;
  rating: number | null;
  tags: string[];
  triggerReason: string;
  addedAt: string;
  dueDate: string;
  intervalDays: number;
  repetitionCount: number;
  state: ReviewState;
  lastReviewedAt: string | null;
  reviewNotes: string | null;
  isDue: boolean;
  cfUrl: string;
}

export interface ReviewQueueSummary {
  totalInQueue: number;
  dueTodayCount: number;
  completedCount: number;
  masteredCount: number;
  deferredCount: number;
  items: ReviewQueueItem[];
}

export interface SolveSession {
  id: string;
  profileId: string;
  problemId: string;
  problemName: string;
  problemRating: number | null;
  tags: string[];
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  activeDurationSeconds: number;
  hintsRevealed: number;
  editorialViewed: boolean;
  outcome: 'IN_PROGRESS' | 'SOLVED_INDEPENDENTLY' | 'SOLVED_WITH_HINTS' | 'SOLVED_WITH_EDITORIAL' | 'UNSOLVED' | 'ABANDONED';
  verifiedAc: boolean;
  perceivedDifficulty: string | null;
  struggleType: string | null;
  keyTakeaway: string | null;
  reflectionNotes: string | null;
  createdAt: string;
}

export interface SessionAnalytics {
  totalSessions: number;
  completedSessions: number;
  totalPracticeMinutes: number;
  independentSolveRate: number;
  hintDependenceRate: number;
  averageSolvingMinutes: number;
  timeByRatingBracket: {
    bracket: string;
    avgMinutes: number;
    sessionsCount: number;
  }[];
  struggleBreakdown: {
    struggleType: string;
    label: string;
    count: number;
    percentage: number;
  }[];
  recentTakeaways: {
    problemId: string;
    problemName: string;
    takeaway: string;
    date: string;
  }[];
}

export interface WeeklyGoal {
  id: string;
  profileId: string;
  weekStartDate: string;
  targetSolvesCount: number;
  targetContestsCount: number;
  focusTopic: string | null;
  targetRatingFloor: number | null;
  actualSolvesCount: number;
  actualContestsCount: number;
  currentStreakDays: number;
  status: 'IN_PROGRESS' | 'ACHIEVED' | 'MISSED';
  updatedAt: string;
}

export interface TrainingPlan {
  date: string;
  profileId: string;
  handle: string;
  currentRating: number;
  streakDays: number;
  dailyProblems: DailyProblem[];
  dueReviews: ReviewQueueItem[];
  weeklyGoal: WeeklyGoal | null;
  topWeaknesses: TopicAnalysis[];
  improvingTopics: TopicAnalysis[];
  skillTracks: SkillTrack[];
  recommendedFocus: string;
}

