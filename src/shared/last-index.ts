/** Index of the last element that matches, or -1. The item a stream is changing is at the end of a long list: scan from there. */
export function lastIndexWhere<T>(list: readonly T[], match: (x: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) return i
  return -1
}
