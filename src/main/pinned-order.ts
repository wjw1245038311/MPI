/**
 * Reorder a pinned list (config.pinnedProjects / config.pinnedThreads).
 * The array order IS the display order of the pinned zone.
 *
 * - If `id` already exists (case-insensitive, Windows paths), it is moved to
 *   rank `target`.
 * - Otherwise it is inserted at rank `target`, i.e. pinned there.
 * Ranks are clamped into [0, length]. The original casing of existing entries
 * is preserved; a newly inserted id keeps the casing it was given.
 */
export function reorderPinned(arr: string[], id: string, target: number): string[] {
  const idx = arr.findIndex((p) => p.toLowerCase() === id.toLowerCase());
  const item = idx >= 0 ? arr[idx] : id;
  // When idx is -1 this filter removes nothing (indices are never -1).
  const without = arr.filter((_, i) => i !== idx);
  let j = Math.trunc(Number(target));
  if (!Number.isFinite(j)) j = 0;
  j = Math.max(0, Math.min(j, without.length));
  return [...without.slice(0, j), item, ...without.slice(j)];
}
