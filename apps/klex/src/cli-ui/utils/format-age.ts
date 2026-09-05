export function formatAge(isoDate: string, now = Date.now()): string {
  const created = new Date(isoDate).getTime();
  if (Number.isNaN(created)) return 'unknown';

  const elapsed = Math.max(0, now - created);
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
