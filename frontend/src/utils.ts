export function getRankColor(rating?: number, rank?: string): string {
  if (!rating && !rank) return 'text-slate-400';
  const r = rating || 0;
  if (r < 1200 || rank?.toLowerCase().includes('newbie')) return 'text-zinc-400';
  if (r < 1400 || rank?.toLowerCase().includes('pupil')) return 'text-emerald-400';
  if (r < 1600 || rank?.toLowerCase().includes('specialist')) return 'text-cyan-400';
  if (r < 1900 || rank?.toLowerCase().includes('expert')) return 'text-blue-400';
  if (r < 2200 || rank?.toLowerCase().includes('candidate')) return 'text-purple-400';
  if (r < 2400 || rank?.toLowerCase().includes('master')) return 'text-amber-400';
  return 'text-rose-500';
}

export function getRankBadgeBg(rating?: number, rank?: string): string {
  if (!rating && rank) {
    if (rank.toLowerCase().includes('newbie')) return 'bg-zinc-800/80 text-zinc-300 border-zinc-700';
    if (rank.toLowerCase().includes('pupil')) return 'bg-emerald-950/60 text-emerald-300 border-emerald-800/50';
    if (rank.toLowerCase().includes('specialist')) return 'bg-cyan-950/60 text-cyan-300 border-cyan-800/50';
    if (rank.toLowerCase().includes('expert')) return 'bg-blue-950/60 text-blue-300 border-blue-800/50';
    if (rank.toLowerCase().includes('candidate')) return 'bg-purple-950/60 text-purple-300 border-purple-800/50';
    if (rank.toLowerCase().includes('master')) return 'bg-amber-950/60 text-amber-300 border-amber-800/50';
    return 'bg-rose-950/60 text-rose-300 border-rose-800/50';
  }
  const r = rating || 0;
  if (r < 1200) return 'bg-zinc-800/80 text-zinc-300 border-zinc-700';
  if (r < 1400) return 'bg-emerald-950/60 text-emerald-300 border-emerald-800/50';
  if (r < 1600) return 'bg-cyan-950/60 text-cyan-300 border-cyan-800/50';
  if (r < 1900) return 'bg-blue-950/60 text-blue-300 border-blue-800/50';
  if (r < 2200) return 'bg-purple-950/60 text-purple-300 border-purple-800/50';
  if (r < 2400) return 'bg-amber-950/60 text-amber-300 border-amber-800/50';
  return 'bg-rose-950/60 text-rose-300 border-rose-800/50';
}

export function formatDateHebron(dateStr?: string | null): string {
  if (!dateStr) return 'Never';
  try {
    const d = new Date(dateStr);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Hebron',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return dateStr;
  }
}

export function formatRelativeTimeAgo(dateStr?: string | null): string {
  if (!dateStr) return 'Never';
  try {
    const timeMs = new Date(dateStr).getTime();
    if (isNaN(timeMs)) return dateStr;
    const diffSec = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
  } catch {
    return dateStr;
  }
}

