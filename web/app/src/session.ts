/**
 * What the page keeps across the trip to the loader's login.
 *
 * The loader answers a request without a session with the login redirect, so a
 * page whose session ended leaves by reloading itself: the loader takes it to
 * the login and back to the same address (ADR-011 D6). A draft the owner was
 * writing at that moment must survive the round trip.
 */

const DRAFT_KEY = 'lifemodel.web.draft';

/**
 * Saves the unsent draft. A browser that refuses storage — disabled cookies, a
 * private window, a full quota — keeps nothing, and the page still leaves.
 */
export function saveDraft(draft: string): void {
  if (draft === '') return;
  try {
    window.sessionStorage.setItem(DRAFT_KEY, draft);
  } catch {
    // Nothing to do: the draft stays in the page that is going away.
  }
}

/** Takes the saved draft back, if there is one, and forgets it. */
export function takeDraft(): string | undefined {
  try {
    const draft = window.sessionStorage.getItem(DRAFT_KEY);
    if (draft === null) return undefined;
    window.sessionStorage.removeItem(DRAFT_KEY);
    return draft;
  } catch {
    return undefined;
  }
}

/**
 * Reloads the page from its own address, so the loader's ForwardAuth redirect
 * takes it to the login and back to where the owner was. `replace` keeps the
 * failed page out of the history, and the page is never framed (its CSP
 * forbids it), so the window that navigates is the top one.
 */
export function leaveForLogin(): void {
  window.location.replace(window.location.href);
}
