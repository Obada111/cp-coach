import React from 'react';
import { 
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine 
} from 'recharts';
import { CFRatingChange } from '../types';

interface Props {
  ratingHistory: CFRatingChange[];
  currentRating?: number;
}

export const RatingChart: React.FC<Props> = ({ ratingHistory }) => {
  if (!ratingHistory || ratingHistory.length === 0) {
    return null;
  }

  const data = ratingHistory.map((item, idx) => {
    const date = new Date(item.ratingUpdateTimeSeconds * 1000);
    return {
      idx: idx + 1,
      date: date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      fullDate: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      contestName: item.contestName,
      rating: item.newRating,
      delta: item.newRating - item.oldRating,
      rank: item.rank,
    };
  });

  const ratings = data.map((d) => d.rating);
  const minR = Math.max(800, Math.min(...ratings) - 60);
  const maxR = Math.max(...ratings) + 60;

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const pos = d.delta >= 0;
    return (
      <div className="p-2.5 bg-slate-900 border border-slate-700 rounded-lg shadow-xl text-xs space-y-1 max-w-[220px]">
        <p className="font-semibold text-slate-200 line-clamp-2">{d.contestName}</p>
        <p className="text-slate-400">{d.fullDate} · Rank #{d.rank}</p>
        <p className="font-bold text-white">
          {d.rating}{' '}
          <span className={pos ? 'text-emerald-400' : 'text-rose-400'}>
            ({pos ? '+' : ''}{d.delta})
          </span>
        </p>
      </div>
    );
  };

  return (
    <div className="w-full h-48 sm:h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis dataKey="date" stroke="#475569" tick={{ fontSize: 10 }} tickLine={false} />
          <YAxis domain={[minR, maxR]} stroke="#475569" tick={{ fontSize: 10 }} tickLine={false} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={1200} stroke="#22c55e" strokeDasharray="2 2" strokeOpacity={0.2} />
          <ReferenceLine y={1400} stroke="#06b6d4" strokeDasharray="2 2" strokeOpacity={0.2} />
          <ReferenceLine y={1600} stroke="#3b82f6" strokeDasharray="2 2" strokeOpacity={0.2} />
          <Line
            type="monotone"
            dataKey="rating"
            stroke="#06b6d4"
            strokeWidth={2}
            dot={{ r: 2.5, fill: '#0891b2', strokeWidth: 0 }}
            activeDot={{ r: 5, fill: '#38bdf8', strokeWidth: 2, stroke: '#fff' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
