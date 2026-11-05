// Values kept in this browser's storage. Storage can be blocked (private
// windows, strict settings); then reads give the fallback and writes report
// false, and the page carries on for this visit only.

export function readText(name) {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

export function writeText(name, value) {
  try {
    localStorage.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

export function readJson(name, fallback) {
  try {
    const text = localStorage.getItem(name);
    return text === null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  return writeText(name, JSON.stringify(value));
}
