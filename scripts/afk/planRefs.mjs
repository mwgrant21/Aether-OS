// Plan references and the spec-approved test.
export function specIsApproved(markdown) {
  const lines = String(markdown).split(/\r?\n/).slice(0, 15);
  return lines.some(
    (l) => /status/i.test(l) && /\bapproved\b/i.test(l)
      && !/\b(awaiting|not approved|unapproved|draft|superseded|rejected)\b/i.test(l),
  );
}

export function specPathOfPlan(markdown) {
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!line.startsWith('**Spec:**')) continue;
    const m = /`([^`]+)`/.exec(line);
    if (m) return m[1];
  }
  return null;
}

export function planRefsIn(text) {
  const seen = [];
  for (const m of String(text).matchAll(/\bplans\/([\w.-]+\.md)/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}
