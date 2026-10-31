import { isValidTimestamp, timestampMilliseconds } from './timestamps';

export interface KnowledgeNote {
  id: string;
  title: string;
  lesson: string;
  problemRef: string | null;
  contestId: number | null;
  topics: string[];
  createdAt: string;
  updatedAt: string;
}

const KEY_PREFIX = 'cp-coach:knowledge-journal:v1:';

export function knowledgeNotesStorageKey(handle: string): string {
  return `${KEY_PREFIX}${handle.toLowerCase()}`;
}

function isKnowledgeNote(value: unknown): value is KnowledgeNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<KnowledgeNote>;
  return typeof note.id === 'string' &&
    note.id.trim().length > 0 &&
    typeof note.title === 'string' &&
    typeof note.lesson === 'string' &&
    (note.problemRef === null || typeof note.problemRef === 'string') &&
    (note.contestId === null || (typeof note.contestId === 'number' && Number.isInteger(note.contestId))) &&
    Array.isArray(note.topics) &&
    note.topics.length <= 20 &&
    note.topics.every((topic) => typeof topic === 'string') &&
    isValidTimestamp(note.createdAt) &&
    isValidTimestamp(note.updatedAt) &&
    timestampMilliseconds(note.updatedAt) >= timestampMilliseconds(note.createdAt);
}

export function validateKnowledgeNotes(value: unknown): KnowledgeNote[] {
  if (!Array.isArray(value)) {
    throw new Error('Backup contains invalid knowledge journal entries.');
  }
  if (value.length > 1000) {
    throw new Error('Knowledge journal exceeds the 1000-entry safety limit.');
  }
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Knowledge journal entry ${index + 1} is malformed.`);
    }
    const note = entry as Partial<KnowledgeNote>;
    if (!isValidTimestamp(note.createdAt)) {
      throw new Error(`Knowledge journal entry ${index + 1} has an invalid createdAt timestamp.`);
    }
    if (!isValidTimestamp(note.updatedAt)) {
      throw new Error(`Knowledge journal entry ${index + 1} has an invalid updatedAt timestamp.`);
    }
    if (timestampMilliseconds(note.updatedAt) < timestampMilliseconds(note.createdAt)) {
      throw new Error(`Knowledge journal entry ${index + 1} has updatedAt earlier than createdAt.`);
    }
    if (!isKnowledgeNote(note)) {
      throw new Error(`Backup contains an invalid knowledge journal entry at position ${index + 1}.`);
    }
  }
  return value as KnowledgeNote[];
}

export function readKnowledgeNotes(handle: string): KnowledgeNote[] {
  try {
    const raw = window.localStorage.getItem(knowledgeNotesStorageKey(handle));
    if (!raw) return [];
    return validateKnowledgeNotes(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('Knowledge journal') || error.message.startsWith('Backup contains invalid knowledge'))
    ) throw error;
    throw new Error('Could not read the private knowledge journal from browser storage.');
  }
}

export function writeKnowledgeNotes(handle: string, notes: KnowledgeNote[]): void {
  try {
    window.localStorage.setItem(knowledgeNotesStorageKey(handle), JSON.stringify(notes));
  } catch {
    throw new Error('Could not save the knowledge journal. Browser storage may be full or unavailable.');
  }
}

export function mergeKnowledgeNotes(existing: KnowledgeNote[], incoming: KnowledgeNote[]): KnowledgeNote[] {
  const merged = new Map(existing.map((note) => [note.id, note]));
  for (const note of incoming) merged.set(note.id, note);
  return Array.from(merged.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
