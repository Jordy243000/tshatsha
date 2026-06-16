const TZ_GEO = {
  'Africa/Kinshasa': { country: 'RDC', city: 'Kinshasa' },
  'Africa/Lubumbashi': { country: 'RDC', city: 'Lubumbashi' },
  'Africa/Brazzaville': { country: 'Congo', city: 'Brazzaville' },
  'Europe/Paris': { country: 'France', city: 'Paris' },
  'Europe/Brussels': { country: 'Belgique', city: 'Bruxelles' },
  'America/New_York': { country: 'USA', city: 'New York' },
};

export function deviceFromUserAgent(ua = '') {
  const s = String(ua);
  if (/tablet|ipad/i.test(s)) return 'Tablette';
  if (/mobile|android|iphone/i.test(s)) return 'Mobile';
  return 'Desktop';
}

export function geoFromTimezone(tz) {
  if (!tz) return { country: null, city: null };
  return TZ_GEO[tz] || { country: null, city: null };
}

export function buildPercentDistribution(rows, labelKey = 'name', countKey = 'count') {
  const total = rows.reduce((s, r) => s + Number(r[countKey] || 0), 0);
  if (!total) return [];
  return rows
    .filter((r) => Number(r[countKey]) > 0)
    .map((r) => ({
      name: r[labelKey] || 'Autre',
      percent: Math.round((Number(r[countKey]) / total) * 100),
      count: Number(r[countKey]),
    }));
}

export function formatListenDuration(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
