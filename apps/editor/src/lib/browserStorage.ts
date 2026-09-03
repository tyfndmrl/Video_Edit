/**
 * `localStorage` access that never throws.
 *
 * Two features need the exact same three lines (the font catalogue cache and
 * the timeline height preference), and both need them for the same reason:
 * storage can be ABSENT (SSR/tests) or BLOCKED (Safari private mode, "block
 * site data"), and in both cases the caller has a working fallback. A second
 * copy of this wrapper is how one of them quietly stops handling the blocked
 * case, so it lives here once.
 *
 * Everything stored through it is a per-browser CONVENIENCE, never a
 * requirement: losing it must leave the app fully functional.
 */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage (private mode / site-data policy): the caller's default
    // carries the feature, so there is nothing to report here.
    return null;
  }
}
