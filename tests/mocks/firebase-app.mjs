// In-memory stand-in for firebase-app (offline tests only — no network).
export function initializeApp() {
  return { __app: true };
}
