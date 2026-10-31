const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const SQLITE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP.exec(value) || SQLITE_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (
    !isValidDateString(`${year}-${month}-${day}`) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) return false;

  const zone = ISO_TIMESTAMP.exec(value)?.[8] || '';
  if (zone && zone !== 'Z') {
    const [, , offsetHours, offsetMinutes] = /^([+-])(\d{2}):(\d{2})$/.exec(zone) || [];
    if (
      offsetHours === undefined ||
      Number(offsetHours) > 14 ||
      Number(offsetMinutes) > 59 ||
      (Number(offsetHours) === 14 && Number(offsetMinutes) !== 0)
    ) return false;
  }
  const normalized = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Number.isFinite(Date.parse(normalized));
}

export function timestampMilliseconds(value: string): number {
  if (!isValidTimestamp(value)) throw new Error('Timestamp must be a valid ISO-8601 or SQLite datetime value.');
  return Date.parse(SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}
