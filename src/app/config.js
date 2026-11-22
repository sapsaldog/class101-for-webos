// Class101's public web config (same values the class101.net bundle ships).
// Login is Firebase Auth email/password; data comes from the Class101 GraphQL gateway.
export const FIREBASE_API_KEY = 'AIzaSyBOybGuB69OpLttriljMZUvEpdFXTqahFY';

const DEFAULT_ENDPOINTS = {
  signIn: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
  refresh: 'https://securetoken.googleapis.com/v1/token',
  lookup: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
  graphql: 'https://cdn-production-gateway.class101.net/graphql',
};

// Tests point the app at a mock server with localStorage["c101:endpoints"].
function overrides() {
  try {
    return JSON.parse(localStorage.getItem('c101:endpoints') || '{}');
  } catch (e) {
    return {};
  }
}

export function endpoint(name) {
  return overrides()[name] || DEFAULT_ENDPOINTS[name];
}
