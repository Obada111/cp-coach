import React, { useState, useEffect } from 'react';
import { ProblemTutorial } from '../types';
import {
  X,
  Lightbulb,
  CheckCircle2,
  Copy,
  Check,
  ExternalLink,
  BookOpen,
  Code2,
  ChevronDown,
  ChevronUp,
  Cpu,
  GraduationCap,
  Sparkles,
} from 'lucide-react';

interface Props {
  tutorial: ProblemTutorial | null;
  isOpen: boolean;
  onClose: () => void;
}

export const TutorialModal: React.FC<Props> = ({ tutorial, isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'hints' | 'tutorial' | 'code'>('hints');
  const [selectedLang, setSelectedLang] = useState<'cpp' | 'python'>('cpp');
  const [revealedHints, setRevealedHints] = useState<{ [key: number]: boolean }>({
    1: false,
    2: false,
    3: false,
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.body.style.overflow = 'auto';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !tutorial) return null;

  const toggleHint = (num: number) => {
    setRevealedHints((prev) => ({ ...prev, [num]: !prev[num] }));
  };

  const handleCopyCode = () => {
    const code = selectedLang === 'cpp' ? tutorial.cppSolution : tutorial.pythonSolution;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity"
        onClick={onClose}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-3xl bg-[#0c101d] border border-cyan-800/50 rounded-2xl shadow-2xl shadow-cyan-950/40 z-10 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800/80 bg-slate-900/60 flex items-start justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-cyan-300 bg-cyan-950/70 border border-cyan-800/60 px-2 py-0.5 rounded-full">
                <Sparkles className="w-3 h-3 text-cyan-400" /> Masterclass Tutorial
              </span>
              {tutorial.rating && (
                <span className="text-xs font-mono text-amber-300/90 bg-amber-950/40 border border-amber-900/40 px-2 py-0.5 rounded-md">
                  ★ {tutorial.rating}
                </span>
              )}
              {tutorial.problemIndex && (
                <span className="text-xs font-mono font-bold text-white bg-slate-800 px-2 py-0.5 rounded-md">
                  {tutorial.contestId ? `${tutorial.contestId}${tutorial.problemIndex}` : tutorial.problemIndex}
                </span>
              )}
            </div>

            <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2 truncate">
              {tutorial.title}
            </h2>

            {tutorial.tags && tutorial.tags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                {tutorial.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] text-slate-400 bg-slate-800/70 border border-slate-700/50 px-2 py-0.5 rounded font-mono"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a
              href={tutorial.cfUrl}
              target="_blank"
              rel="noreferrer"
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-all text-xs flex items-center gap-1"
              title="Open problem on Codeforces"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-rose-950/60 hover:text-rose-300 text-slate-400 transition-all"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center border-b border-slate-800/80 bg-slate-950/40 px-5 gap-2">
          <button
            onClick={() => setActiveTab('hints')}
            className={`flex items-center gap-1.5 py-3 px-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'hints'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            Progressive Hints
          </button>
          <button
            onClick={() => setActiveTab('tutorial')}
            className={`flex items-center gap-1.5 py-3 px-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'tutorial'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            Detailed Tutorial & Proof
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`flex items-center gap-1.5 py-3 px-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'code'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            Optimal Solution Code
          </button>
        </div>

        {/* Modal Body (Scrollable) */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5">
          {/* ════ TAB 1: PROGRESSIVE HINTS ════ */}
          {activeTab === 'hints' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-cyan-950/20 border border-cyan-800/30 text-xs text-cyan-200/90 leading-relaxed">
                💡 <strong>Coach Advice:</strong> Try reading <em>Hint 1</em> first and think for 5–10 minutes. Only reveal further hints if you are truly stuck. This strengthens your competitive programming pattern recognition!
              </div>

              {/* Hint 1 */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
                <button
                  onClick={() => toggleHint(1)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-800/40 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-cyan-950 border border-cyan-800 flex items-center justify-center text-xs font-bold text-cyan-400">
                      1
                    </span>
                    <span className="text-xs font-bold text-white">Hint 1: Key Observation & Invariant</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{revealedHints[1] ? 'Hide' : 'Reveal'}</span>
                    {revealedHints[1] ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </div>
                </button>
                {revealedHints[1] && (
                  <div className="px-4 pb-4 pt-1 text-xs text-slate-300 border-t border-slate-800/60 bg-slate-950/40 leading-relaxed animate-fadeIn">
                    {tutorial.hint1}
                  </div>
                )}
              </div>

              {/* Hint 2 */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
                <button
                  onClick={() => toggleHint(2)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-800/40 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-indigo-950 border border-indigo-800 flex items-center justify-center text-xs font-bold text-indigo-400">
                      2
                    </span>
                    <span className="text-xs font-bold text-white">Hint 2: Algorithmic Blueprint & Data Structures</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{revealedHints[2] ? 'Hide' : 'Reveal'}</span>
                    {revealedHints[2] ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </div>
                </button>
                {revealedHints[2] && (
                  <div className="px-4 pb-4 pt-1 text-xs text-slate-300 border-t border-slate-800/60 bg-slate-950/40 leading-relaxed animate-fadeIn">
                    {tutorial.hint2}
                  </div>
                )}
              </div>

              {/* Hint 3 */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
                <button
                  onClick={() => toggleHint(3)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-800/40 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-amber-950 border border-amber-800 flex items-center justify-center text-xs font-bold text-amber-400">
                      3
                    </span>
                    <span className="text-xs font-bold text-white">Hint 3: Corner Cases & Common Pitfalls</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{revealedHints[3] ? 'Hide' : 'Reveal'}</span>
                    {revealedHints[3] ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </div>
                </button>
                {revealedHints[3] && (
                  <div className="px-4 pb-4 pt-1 text-xs text-slate-300 border-t border-slate-800/60 bg-slate-950/40 leading-relaxed animate-fadeIn">
                    {tutorial.hint3}
                  </div>
                )}
              </div>

              {/* Action to switch to full tutorial */}
              <div className="pt-2 text-center">
                <button
                  onClick={() => setActiveTab('tutorial')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/30 text-xs font-semibold text-cyan-300 transition-all"
                >
                  <BookOpen className="w-3.5 h-3.5" /> Read Full Masterclass Tutorial & Proof →
                </button>
              </div>
            </div>
          )}

          {/* ════ TAB 2: DETAILED TUTORIAL & PROOF ════ */}
          {activeTab === 'tutorial' && (
            <div className="space-y-5 text-xs text-slate-300 leading-relaxed">
              {/* Problem Breakdown in Plain English */}
              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
                <h3 className="text-xs font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5 text-cyan-400" /> Plain-English Problem Breakdown
                </h3>
                <p className="text-slate-300 text-xs leading-relaxed">{tutorial.tutorial.overview}</p>
              </div>

              {/* Key Insights */}
              {tutorial.tutorial.keyInsights && tutorial.tutorial.keyInsights.length > 0 && (
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2.5">
                  <h3 className="text-xs font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400" /> Key Insights & Mental Models
                  </h3>
                  <ul className="space-y-2">
                    {tutorial.tutorial.keyInsights.map((insight, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                        <span className="text-slate-300">{insight}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Mathematical / Logical Proof */}
              {tutorial.tutorial.mathematicalProof && (
                <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/40 space-y-2">
                  <h3 className="text-xs font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5">
                    <GraduationCap className="w-3.5 h-3.5 text-emerald-400" /> Correctness & Mathematical Proof
                  </h3>
                  <p className="text-slate-300 text-xs leading-relaxed">
                    {tutorial.tutorial.mathematicalProof}
                  </p>
                </div>
              )}

              {/* Step-by-Step Algorithm */}
              {tutorial.tutorial.algorithmSteps && tutorial.tutorial.algorithmSteps.length > 0 && (
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2.5">
                  <h3 className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-amber-400" /> Step-by-Step Execution Plan
                  </h3>
                  <div className="space-y-1.5">
                    {tutorial.tutorial.algorithmSteps.map((step, idx) => (
                      <div key={idx} className="flex items-start gap-2 bg-slate-950/50 p-2.5 rounded-lg border border-slate-800/60">
                        <span className="font-mono text-cyan-400 font-bold shrink-0">{idx + 1}.</span>
                        <span className="text-slate-300">{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Complexity Analysis */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Time Complexity</span>
                  <div className="font-mono text-cyan-300 text-xs font-bold">
                    {tutorial.tutorial.timeComplexity}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Space Complexity</span>
                  <div className="font-mono text-indigo-300 text-xs font-bold">
                    {tutorial.tutorial.spaceComplexity}
                  </div>
                </div>
              </div>

              {/* Practice Takeaways */}
              {tutorial.takeaways && tutorial.takeaways.length > 0 && (
                <div className="p-4 rounded-xl bg-violet-950/20 border border-violet-900/40 space-y-2">
                  <h3 className="text-xs font-bold text-violet-300 uppercase tracking-wider flex items-center gap-1.5">
                    🎯 Contest Takeaways to Remember
                  </h3>
                  <ul className="space-y-1.5">
                    {tutorial.takeaways.map((item, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-slate-300">
                        <span className="text-violet-400 font-bold">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Jump to Code */}
              <div className="pt-2 text-center">
                <button
                  onClick={() => setActiveTab('code')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/30 text-xs font-semibold text-cyan-300 transition-all"
                >
                  <Code2 className="w-3.5 h-3.5" /> View Optimal Clean Code Implementation →
                </button>
              </div>
            </div>
          )}

          {/* ════ TAB 3: OPTIMAL SOLUTION CODE ════ */}
          {activeTab === 'code' && (
            <div className="space-y-4">
              {/* Language switcher + Copy button */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-1 gap-1">
                  <button
                    onClick={() => setSelectedLang('cpp')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      selectedLang === 'cpp'
                        ? 'bg-cyan-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    C++ (Optimal)
                  </button>
                  <button
                    onClick={() => setSelectedLang('python')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      selectedLang === 'python'
                        ? 'bg-cyan-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Python 3
                  </button>
                </div>

                <button
                  onClick={handleCopyCode}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 hover:text-white transition-all border border-slate-700/60"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-300">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Code</span>
                    </>
                  )}
                </button>
              </div>

              {/* Code viewer */}
              <div className="relative rounded-xl border border-slate-800 bg-[#070a14] overflow-hidden">
                <div className="px-4 py-2 border-b border-slate-800/80 bg-slate-950/60 flex items-center justify-between text-[11px] text-slate-500 font-mono">
                  <span>{selectedLang === 'cpp' ? 'solution.cpp' : 'solution.py'}</span>
                  <span>Fast I/O & Fully Commented</span>
                </div>
                <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed select-all">
                  <code>{selectedLang === 'cpp' ? tutorial.cppSolution : tutorial.pythonSolution}</code>
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800/80 bg-slate-900/60 flex items-center justify-between">
          <span className="text-[11px] text-slate-500">
            CP Coach · Progressive tutorial
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-all"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
