// EvidenceBundleV1 -- the immutable, hashed provenance record every
// cross-engine claim must cite.
//
// See ~/agent-improvement/prototyping-tasks/aether-cross-engine-deliberation-broker-2026-09-04.md,
// "Minimal prototype" step 4. The existing DispatchEvidence
// (electron/crossEngine/dispatchEvidence.ts) answers "what did this dispatch
// claim, and which files did it touch". That is enough for a single one-shot
// verification, but not for a multi-round deliberation, where two providers
// argue about a tree that may move underneath them. This type answers the
// harder question: *exactly which bytes was a claim made about, and can that
// still be proven later*.
//
// Two rules make it worth having at all:
//
//   1. A bundle is content-addressed. Every field that a claim can cite is
//      hashed, and the whole bundle is covered by a manifest hash over a
//      canonical serialization. Tampering with a citation, a line range, or
//      the file it points at makes verification fail.
//   2. A bundle carries no payload. Hashes, byte counts, project-relative
//      paths and line numbers only -- never file contents, command output, or
//      absolute paths. This is the same "store the signal, not the payload"
//      rule CLAUDE.md and docs/privacy-and-data.md already bind the rest of
//      the store to, applied to the one structure most tempted to break it.
//
// Cross-platform note: paths are normalized to forward slashes and hashed
// that way, so a bundle built on Windows and the same tree on Linux produce
// identical hashes. Without that, the Windows CI lane would disagree with the
// Linux lane on every manifest hash for reasons that have nothing to do with
// the evidence.

import { createHash } from 'node:crypto';

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1 as const;

export type EvidenceFileStatus = 'present' | 'deleted';

export interface EvidenceFileRef {
  /** Project-relative, forward-slash separated. Never absolute. */
  path: string;
  /** sha256 of the file's bytes at bundle time. Empty string when deleted. */
  sha256: string;
  bytes: number;
  status: EvidenceFileStatus;
}

/** A specific, citable region of a file. `sha256` covers exactly the lines in
 *  [startLine, endLine], joined with '\n' -- not the whole file -- so a claim
 *  about lines 10-20 stays verifiable when line 400 changes. */
export interface EvidenceLineRange {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
}

/** A test the providers may propose and Aether may run. Recorded as
 *  provenance, never executed by this module. */
export interface EvidenceTestCommand {
  command: string;
  argv: string[];
  /** Snapshot-relative working directory. Never absolute. */
  cwdRel: string;
}

export interface EvidenceProvenance {
  /** Derived project identity (src/shared/projectIdentity.ts's `key`), not a
   *  path -- the same value that already crosses IPC elsewhere. */
  projectKey: string;
  /** git HEAD the snapshot was built from. */
  baseSha: string;
  /** sha256 of `git diff HEAD`, or null when the tree was clean. The diff
   *  itself is NOT stored -- only proof of which uncommitted state was in
   *  play. */
  dirtyPatchSha256: string | null;
  branch: string | null;
}

export interface EvidenceBundleV1 {
  schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
  bundleId: string;
  createdAtIso: string;
  provenance: EvidenceProvenance;
  files: EvidenceFileRef[];
  lineRanges: EvidenceLineRange[];
  tests: EvidenceTestCommand[];
  /** sha256 over the canonical serialization of every field above. */
  manifestSha256: string;
}

/** What a provider must supply to make a claim checkable. */
export interface EvidenceCitation {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Forward slashes, no leading './'. Backslashes are treated as separators,
 *  which is correct for the Windows paths this runs on and harmless elsewhere
 *  (a literal backslash in a POSIX filename is vanishingly rare and not worth
 *  an unhashable path).
 *
 *  THROWS on an absolute path rather than quietly relativizing it. Rule 2 of
 *  this module ("carries no payload... never absolute paths") was previously
 *  enforced only by comment: `C:\Users\<name>\...` normalized to
 *  `C:/Users/<name>/...` and was then hashed, sealed and deep-frozen into an
 *  immutable record explicitly designed not to hold it. Stripping the prefix
 *  instead would be worse than throwing -- two different absolute paths can
 *  collapse to the same relative one, silently making distinct files look like
 *  the same evidence. An absolute path here is a caller bug; surface it. */
export function normalizeEvidencePath(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^[A-Za-z]:\//.test(slashed)) {
    throw new Error('evidence paths must be project-relative, got a drive-absolute path');
  }
  if (slashed.startsWith('//')) {
    throw new Error('evidence paths must be project-relative, got a UNC path');
  }
  if (slashed.startsWith('/')) {
    throw new Error('evidence paths must be project-relative, got an absolute path');
  }
  // Rejecting absolute paths alone was not enough: '../../etc/secret' is
  // relative and still escapes the project root, which would let a bundle
  // cite a file outside the snapshot it claims to describe.
  if (slashed.split('/').some((seg) => seg === '..')) {
    throw new Error('evidence paths must be project-relative, got a parent-directory traversal');
  }
  return slashed;
}

/** Deterministic serialization: object keys sorted recursively, arrays kept in
 *  their given order (order is meaningful for line ranges and test steps).
 *  JSON.stringify's default key order is insertion order, which would make the
 *  manifest hash depend on how the bundle happened to be constructed. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

type UnsealedBundle = Omit<EvidenceBundleV1, 'manifestSha256'>;

export function computeManifestSha256(bundle: UnsealedBundle): string {
  return sha256(canonicalize(bundle));
}

/** Hashes exactly the given 1-based inclusive line span of `content`.
 *  Line endings are normalized to '\n' first, for the same cross-platform
 *  reason the paths are: the identical source file checked out with CRLF on
 *  Windows and LF on Linux must hash identically. */
export function hashLineRange(content: string, startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error('invalid line range: ' + startLine + '-' + endLine);
  }
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (endLine > lines.length) {
    throw new Error('line range ' + startLine + '-' + endLine + ' exceeds file length ' + lines.length);
  }
  return sha256(lines.slice(startLine - 1, endLine).join('\n'));
}

export interface BuildEvidenceBundleInput {
  bundleId: string;
  createdAtIso: string;
  provenance: EvidenceProvenance;
  files: EvidenceFileRef[];
  lineRanges?: EvidenceLineRange[];
  tests?: EvidenceTestCommand[];
}

/**
 * Builds and seals a bundle. The result is deep-frozen: the "immutable" in
 * "immutable evidence bundle" is enforced at runtime, not just documented,
 * because the whole point is that a later round cannot quietly edit the
 * evidence an earlier round's claims were checked against.
 *
 * Pure: it does no filesystem or git work. Callers gather the hashes (the
 * snapshot builder already walks exactly the right file set) and hand them
 * here, which keeps this testable with no repo, no git, and no credentials --
 * a hard requirement for the Windows CI lane.
 */
export function buildEvidenceBundle(input: BuildEvidenceBundleInput): EvidenceBundleV1 {
  const seenPaths = new Set<string>();
  for (const f of input.files) {
    const norm = normalizeEvidencePath(f.path);
    if (seenPaths.has(norm)) {
      // Two records for one path make isCitationSupported's .find() pick
      // whichever happened to sort first, so a citation could validate against
      // a `present` entry while a conflicting `deleted` one sits in the same
      // bundle and the manifest hash still verifies.
      throw new Error('duplicate evidence file entry for ' + norm);
    }
    seenPaths.add(norm);
  }

  const unsealed: UnsealedBundle = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    bundleId: input.bundleId,
    createdAtIso: input.createdAtIso,
    provenance: { ...input.provenance },
    files: input.files
      .map((f) => ({ ...f, path: normalizeEvidencePath(f.path) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    lineRanges: (input.lineRanges ?? []).map((r) => ({ ...r, path: normalizeEvidencePath(r.path) })),
    tests: (input.tests ?? []).map((t) => ({ ...t, cwdRel: normalizeEvidencePath(t.cwdRel) })),
  };
  const sealed: EvidenceBundleV1 = { ...unsealed, manifestSha256: computeManifestSha256(unsealed) };
  return deepFreeze(sealed);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export type BundleVerdict = { ok: true } | { ok: false; reason: string };

/** Re-derives the manifest hash and compares. Any edit to any covered field
 *  -- a swapped file hash, an added line range, a changed base SHA -- makes
 *  this fail. */
export function verifyEvidenceBundle(bundle: EvidenceBundleV1): BundleVerdict {
  if (bundle.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    return { ok: false, reason: 'unrecognized evidence bundle schema version' };
  }
  const { manifestSha256: _claimed, ...unsealed } = bundle;
  const recomputed = computeManifestSha256(unsealed as UnsealedBundle);
  if (recomputed !== bundle.manifestSha256) {
    return { ok: false, reason: 'manifest hash mismatch: bundle was modified after sealing' };
  }
  return { ok: true };
}

/**
 * The provenance gate the plan's verification section requires: "modify a
 * cited file/hash/line and require the claim to become unsupported."
 *
 * A citation is supported only when the bundle itself verifies AND the bundle
 * contains a line range with the same path, the same span, and the same hash.
 * Consensus between providers does not enter into it -- two providers
 * agreeing on an unsupported citation still yields `false`.
 */
export function isCitationSupported(bundle: EvidenceBundleV1, citation: EvidenceCitation): BundleVerdict {
  const bundleVerdict = verifyEvidenceBundle(bundle);
  if (!bundleVerdict.ok) return bundleVerdict;

  let path: string;
  try {
    path = normalizeEvidencePath(citation.path);
  } catch (err) {
    // A citation is untrusted provider output, so a malformed path is an
    // unsupported claim rather than a crash.
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid citation path' };
  }
  const file = bundle.files.find((f) => f.path === path);
  if (!file) return { ok: false, reason: 'cited file is not in the evidence bundle: ' + path };
  if (file.status === 'deleted') return { ok: false, reason: 'cited file was deleted: ' + path };

  const range = bundle.lineRanges.find(
    (r) => r.path === path && r.startLine === citation.startLine && r.endLine === citation.endLine
  );
  if (!range) {
    return {
      ok: false,
      reason: 'no verified line range ' + citation.startLine + '-' + citation.endLine + ' for ' + path,
    };
  }
  if (range.sha256 !== citation.sha256) {
    return { ok: false, reason: 'cited content hash does not match the verified range for ' + path };
  }
  return { ok: true };
}
