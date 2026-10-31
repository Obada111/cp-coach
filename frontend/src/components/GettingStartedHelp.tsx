import React from 'react';
import { BookOpen } from 'lucide-react';

export const GettingStartedHelp: React.FC = () => (
  <details className="rounded-xl border border-slate-800 bg-slate-900/60">
    <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-xs font-semibold text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500">
      <BookOpen className="h-4 w-4 text-cyan-400" />
      How the coach works
    </summary>
    <div className="space-y-2 border-t border-slate-800 px-4 py-3 text-xs leading-relaxed text-slate-400">
      <p><strong className="text-rose-300">Weakness drill</strong> targets topics supported by your submission and practice evidence; topics with little evidence are marked unexplored, not weak.</p>
      <p><strong className="text-amber-300">Reinforcement</strong> revisits useful skills, while <strong className="text-violet-300">Challenge</strong> offers a harder stretch.</p>
      <p>After working on a problem, save feedback for whether you solved it independently, with hints, after an editorial, or not yet—and add difficulty, time, or a note. This evidence can shape later recommendations and reviews.</p>
      <p>Opening a Codeforces link only records that you opened it; it does not count as a solve. A solve is verified from Codeforces submissions or marked separately as self-reported.</p>
      <p>Struggles can enter the review queue. Review performance adjusts the spacing between future reviews; one success alone does not establish mastery.</p>
      <p>Use <strong className="text-slate-200">Settings → Learning Data Backup</strong> to export or restore a JSON backup. Learning history is tied to this browser; clearing its data can erase it, and it does not automatically sync across devices.</p>
    </div>
  </details>
);
