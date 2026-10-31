import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  KnowledgeNote,
  readKnowledgeNotes,
  writeKnowledgeNotes,
} from '../knowledgeJournal';

interface Props {
  handle: string;
  weakTopics: string[];
}

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const KnowledgeJournal: React.FC<Props> = ({ handle, weakTopics }) => {
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [title, setTitle] = useState('');
  const [lesson, setLesson] = useState('');
  const [problemRef, setProblemRef] = useState('');
  const [contestRef, setContestRef] = useState('');
  const [topicInput, setTopicInput] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [topicFilter, setTopicFilter] = useState('ALL');
  const [error, setError] = useState<string | null>(null);
  const [journalReady, setJournalReady] = useState(false);

  useEffect(() => {
    setJournalReady(false);
    try {
      setNotes(readKnowledgeNotes(handle));
      setError(null);
      setJournalReady(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load journal entries.');
    }
    setEditingId(null);
  }, [handle]);

  const topics = useMemo(
    () => Array.from(new Set(notes.flatMap((note) => note.topics))).sort(),
    [notes]
  );
  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    return notes.filter((note) => {
      if (topicFilter !== 'ALL' && !note.topics.includes(topicFilter)) return false;
      if (!query) return true;
      return [note.title, note.lesson, note.problemRef || '', String(note.contestId || ''), ...note.topics]
        .join(' ')
        .toLowerCase()
        .includes(query);
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [notes, search, topicFilter]);

  const relevantNotes = notes.filter((note) =>
    note.topics.some((topic) => weakTopics.includes(topic.toLowerCase()))
  );

  const resetForm = () => {
    setTitle('');
    setLesson('');
    setProblemRef('');
    setContestRef('');
    setTopicInput('');
    setEditingId(null);
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    if (!journalReady) return;
    setError(null);
    const cleanTitle = title.trim();
    const cleanLesson = lesson.trim();
    const contestId = contestRef.trim() ? Number(contestRef) : null;
    if (!cleanTitle || !cleanLesson) {
      setError('Add both a short title and the lesson or observation.');
      return;
    }
    if (contestId !== null && (!Number.isInteger(contestId) || contestId <= 0)) {
      setError('Contest ID must be a positive whole number.');
      return;
    }

    const now = new Date().toISOString();
    const previous = notes.find((note) => note.id === editingId);
    const tags = Array.from(new Set(topicInput.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))).slice(0, 20);
    const nextNote: KnowledgeNote = {
      id: previous?.id || makeId(),
      title: cleanTitle.slice(0, 120),
      lesson: cleanLesson.slice(0, 10000),
      problemRef: problemRef.trim().slice(0, 120) || null,
      contestId,
      topics: tags,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    const next = [nextNote, ...notes.filter((note) => note.id !== nextNote.id)];
    if (next.length > 1000) {
      setError('The journal limit of 1,000 entries has been reached. Export a backup before removing old entries.');
      return;
    }
    try {
      writeKnowledgeNotes(handle, next);
      setNotes(next);
      resetForm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save this journal entry.');
    }
  };

  const editNote = (note: KnowledgeNote) => {
    setEditingId(note.id);
    setTitle(note.title);
    setLesson(note.lesson);
    setProblemRef(note.problemRef || '');
    setContestRef(note.contestId ? String(note.contestId) : '');
    setTopicInput(note.topics.join(', '));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const deleteNote = (id: string) => {
    if (!window.confirm('Delete this private journal entry?')) return;
    const next = notes.filter((note) => note.id !== id);
    try {
      writeKnowledgeNotes(handle, next);
      setNotes(next);
      if (editingId === id) resetForm();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete this journal entry.');
    }
  };

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-cyan-400" /> Personal CP Knowledge Journal
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Private to this browser. Save algorithms, invariants, implementation tricks, and mistakes.
        </p>
      </header>

      {relevantNotes.length > 0 && (
        <section className="p-4 rounded-xl bg-indigo-950/30 border border-indigo-900/60">
          <h3 className="text-xs font-semibold text-indigo-200">Concepts to revisit</h3>
          <p className="text-[11px] text-slate-400 mt-1">
            These notes match topics the current evidence-based analysis marked as needing practice.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {relevantNotes.slice(0, 5).map((note) => (
              <button
                type="button"
                key={note.id}
                onClick={() => editNote(note)}
                className="px-2.5 py-1 rounded-lg bg-slate-900 border border-indigo-900/70 text-[11px] text-indigo-100 hover:border-indigo-500"
              >
                {note.title} · {note.topics.filter((topic) => weakTopics.includes(topic.toLowerCase())).join(', ')}
              </button>
            ))}
          </div>
        </section>
      )}

      <form onSubmit={handleSave} className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-white">{editingId ? 'Edit journal entry' : 'New journal entry'}</h3>
          {editingId && <button type="button" onClick={resetForm} className="text-xs text-slate-400 hover:text-white">Cancel edit</button>}
        </div>
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Title (e.g. Prefix-sum invariant)" className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500" />
        <textarea value={lesson} onChange={(event) => setLesson(event.target.value)} maxLength={10000} rows={4} placeholder="The observation, invariant, proof idea, or mistake worth remembering..." className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input value={problemRef} onChange={(event) => setProblemRef(event.target.value)} placeholder="Problem ID or URL" className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500" />
          <input value={contestRef} onChange={(event) => setContestRef(event.target.value)} inputMode="numeric" placeholder="Contest ID (optional)" className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500" />
          <input value={topicInput} onChange={(event) => setTopicInput(event.target.value)} placeholder="Topic tags, comma separated" className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500" />
        </div>
        <button type="submit" disabled={!journalReady} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-xs font-semibold text-white disabled:opacity-40">
          {editingId ? <Pencil className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          {editingId ? 'Save changes' : 'Save lesson'}
        </button>
      </form>

      {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, lesson, problem, contest, or topic" className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500" />
        </div>
        <select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200">
          <option value="ALL">All topics</option>
          {topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
        </select>
      </div>

      {filteredNotes.length === 0 ? (
        <div className="p-6 rounded-xl border border-slate-800 bg-slate-900/60 text-xs text-slate-500">
          {notes.length ? 'No entries match this search.' : 'No journal entries yet. Save a lesson after your next practice session.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredNotes.map((note) => (
            <article key={note.id} className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">{note.title}</h3>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    Updated {new Date(note.updatedAt).toLocaleString()}
                    {note.problemRef && ` · ${note.problemRef}`}
                    {note.contestId && ` · Contest ${note.contestId}`}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => editNote(note)} aria-label={`Edit ${note.title}`} className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800"><Pencil className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => deleteNote(note.id)} aria-label={`Delete ${note.title}`} className="p-1.5 rounded text-slate-400 hover:text-rose-300 hover:bg-slate-800"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <p className="text-xs text-slate-300 whitespace-pre-wrap">{note.lesson}</p>
              {note.topics.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {note.topics.map((topic) => <span key={topic} className="px-2 py-0.5 rounded bg-slate-800 text-[10px] text-cyan-300">#{topic}</span>)}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
};
