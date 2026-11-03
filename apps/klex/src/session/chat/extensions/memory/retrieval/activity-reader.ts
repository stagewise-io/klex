import { type ActivityHistory, activityOrdinal } from '@/activity-history';

export interface ActivityEntry {
  sourceId: string;
  entryOrdinal: number;
  occurredAt: string;
  text: string;
}

/** Bounded canonical-source access. No archive files or cached evidence fallback. */
export class ActivityEntryStore {
  constructor(private readonly history: ActivityHistory) {}

  async listSources() {
    if (!this.history.isAvailable())
      throw new Error('Canonical history unavailable');
    return this.history.manifest();
  }

  async read(sourceId: string): Promise<ActivityEntry[]> {
    const page = await this.history.readPage(sourceId, {
      offset: 0,
      limit: 60_000,
      maxBytes: 2_000_000,
    });
    if (!page) return [];
    // A message is independently capped by the existing projection. The page
    // delimiter is presentation, never a transport format parsed back into parts.
    return page.text
      ? [
          {
            sourceId,
            entryOrdinal: 0,
            occurredAt: page.startedAt!,
            text: page.text,
          },
        ]
      : [];
  }

  async readNeighbors(
    location: ActivityEntry,
    before: number,
    after: number,
  ): Promise<ActivityEntry[]> {
    const current = await this.read(location.sourceId);
    if (
      !current.some(
        (entry) =>
          entry.entryOrdinal === location.entryOrdinal &&
          entry.text === location.text,
      )
    )
      return [];
    const refs = await this.history.listNeighbors(
      location.sourceId,
      Math.max(before, after),
    );
    const ordinal = activityOrdinal(location.sourceId)!;
    const beforeRefs = refs
      .filter((source) => source.ordinal < ordinal)
      .sort((left, right) => right.ordinal - left.ordinal)
      .slice(0, Math.max(0, before))
      .reverse();
    const afterRefs = refs
      .filter((source) => source.ordinal > ordinal)
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(0, Math.max(0, after));
    const older = await Promise.all(beforeRefs.map((ref) => this.read(ref.id)));
    const newer = await Promise.all(afterRefs.map((ref) => this.read(ref.id)));
    return [...older.flat(), ...current, ...newer.flat()];
  }
}
