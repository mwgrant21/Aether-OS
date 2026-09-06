// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  buildEvidenceBundle,
  computeManifestSha256,
  hashLineRange,
  isCitationSupported,
  normalizeEvidencePath,
  sha256,
  verifyEvidenceBundle,
  type EvidenceBundleV1,
  type BuildEvidenceBundleInput,
} from './evidenceBundle';

const FILE_CONTENT = ['line one', 'line two', 'line three', 'line four'].join('\n');

function baseInput(): BuildEvidenceBundleInput {
  return {
    bundleId: 'bundle-1',
    createdAtIso: '2026-09-06T06:00:00.000Z',
    provenance: {
      projectKey: 'aether-os',
      baseSha: 'ad6b850aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dirtyPatchSha256: null,
      branch: 'master',
    },
    files: [
      { path: 'src/thing.ts', sha256: sha256(FILE_CONTENT), bytes: FILE_CONTENT.length, status: 'present' },
    ],
    lineRanges: [{ path: 'src/thing.ts', startLine: 2, endLine: 3, sha256: hashLineRange(FILE_CONTENT, 2, 3) }],
    tests: [{ command: 'npm', argv: ['test'], cwdRel: '.' }],
  };
}

describe('normalizeEvidencePath', () => {
  it('normalizes Windows separators so a bundle hashes identically on both platforms', () => {
    expect(normalizeEvidencePath('src\\thing.ts')).toBe('src/thing.ts');
    expect(normalizeEvidencePath('./src/thing.ts')).toBe('src/thing.ts');
  });

  // Rule 2 of the module ("never absolute paths") used to be enforced only by
  // a comment: a drive-absolute path was silently relativized, hashed and
  // sealed, putting the operator's home directory inside an immutable record.
  it('throws on an absolute path rather than quietly relativizing it', () => {
    expect(() => normalizeEvidencePath('C:\\Users\\someone\\proj\\a.ts')).toThrow(/project-relative/);
    expect(() => normalizeEvidencePath('/src/thing.ts')).toThrow(/project-relative/);
    expect(() => normalizeEvidencePath('\\\\server\\share\\a.ts')).toThrow(/project-relative/);
  });
});

describe('hashLineRange', () => {
  it('hashes only the cited span, so an edit elsewhere in the file does not disturb it', () => {
    const edited = FILE_CONTENT.replace('line four', 'line four (edited)');
    expect(hashLineRange(edited, 2, 3)).toBe(hashLineRange(FILE_CONTENT, 2, 3));
  });

  it('changes when the cited span itself changes', () => {
    const edited = FILE_CONTENT.replace('line two', 'line two (edited)');
    expect(hashLineRange(edited, 2, 3)).not.toBe(hashLineRange(FILE_CONTENT, 2, 3));
  });

  it('treats CRLF and LF checkouts of the same file as identical', () => {
    const crlf = FILE_CONTENT.replace(/\n/g, '\r\n');
    expect(hashLineRange(crlf, 1, 4)).toBe(hashLineRange(FILE_CONTENT, 1, 4));
  });

  it('rejects an out-of-bounds or inverted range rather than hashing nothing', () => {
    expect(() => hashLineRange(FILE_CONTENT, 3, 2)).toThrow();
    expect(() => hashLineRange(FILE_CONTENT, 1, 99)).toThrow();
    expect(() => hashLineRange(FILE_CONTENT, 0, 2)).toThrow();
  });
});

describe('buildEvidenceBundle', () => {
  it('seals with a manifest hash that verifies', () => {
    const bundle = buildEvidenceBundle(baseInput());
    expect(bundle.manifestSha256).toHaveLength(64);
    expect(verifyEvidenceBundle(bundle)).toEqual({ ok: true });
  });

  it('is deep-frozen -- immutability is enforced, not just documented', () => {
    const bundle = buildEvidenceBundle(baseInput());
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.files)).toBe(true);
    expect(Object.isFrozen(bundle.files[0])).toBe(true);
    expect(Object.isFrozen(bundle.provenance)).toBe(true);
  });

  it('produces the same manifest hash regardless of input file order', () => {
    const a = baseInput();
    const b = baseInput();
    const second = { path: 'src/other.ts', sha256: sha256('x'), bytes: 1, status: 'present' as const };
    a.files = [a.files[0], second];
    b.files = [second, b.files[0]];
    expect(buildEvidenceBundle(a).manifestSha256).toBe(buildEvidenceBundle(b).manifestSha256);
  });

  it('produces the same manifest hash for Windows- and POSIX-shaped paths', () => {
    const win = baseInput();
    win.files = [{ ...win.files[0], path: 'src\\thing.ts' }];
    win.lineRanges = [{ ...win.lineRanges![0], path: 'src\\thing.ts' }];
    expect(buildEvidenceBundle(win).manifestSha256).toBe(buildEvidenceBundle(baseInput()).manifestSha256);
  });

  it('rejects two records for the same path', () => {
    const input = baseInput();
    input.files = [
      { path: 'src/thing.ts', sha256: sha256('a'), bytes: 1, status: 'present' },
      { path: 'src\\thing.ts', sha256: sha256('b'), bytes: 1, status: 'deleted' },
    ];
    // Otherwise isCitationSupported's .find() validates against whichever
    // record sorted first while the conflicting one sits in the same bundle
    // and the manifest hash still verifies.
    expect(() => buildEvidenceBundle(input)).toThrow(/duplicate/);
  });

  it('refuses to seal a bundle containing an absolute file path', () => {
    const input = baseInput();
    input.files = [{ path: 'C:\\Users\\someone\\a.ts', sha256: sha256('x'), bytes: 1, status: 'present' }];
    expect(() => buildEvidenceBundle(input)).toThrow(/project-relative/);
  });

  it('carries no file contents, command output, or absolute paths', () => {
    const bundle = buildEvidenceBundle(baseInput());
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('line one');
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/); // no drive-letter absolute path
    expect(serialized).not.toContain('/home/');
    expect(serialized).not.toContain('/Users/');
  });
});

describe('verifyEvidenceBundle', () => {
  /** Rebuilds a mutated copy: the real bundle is frozen, so tampering has to
   *  happen on a clone -- which is itself the property under test. */
  const tampered = (mutate: (b: EvidenceBundleV1) => void): EvidenceBundleV1 => {
    const clone = JSON.parse(JSON.stringify(buildEvidenceBundle(baseInput()))) as EvidenceBundleV1;
    mutate(clone);
    return clone;
  };

  it('rejects a swapped file hash', () => {
    const b = tampered((x) => {
      x.files[0].sha256 = sha256('something else');
    });
    expect(verifyEvidenceBundle(b).ok).toBe(false);
  });

  it('rejects a changed base SHA', () => {
    const b = tampered((x) => {
      x.provenance.baseSha = 'deadbeef';
    });
    expect(verifyEvidenceBundle(b).ok).toBe(false);
  });

  it('rejects an appended line range', () => {
    const b = tampered((x) => {
      x.lineRanges.push({ path: 'src/thing.ts', startLine: 1, endLine: 1, sha256: sha256('line one') });
    });
    expect(verifyEvidenceBundle(b).ok).toBe(false);
  });

  it('rejects an added test command', () => {
    const b = tampered((x) => {
      x.tests.push({ command: 'rm', argv: ['-rf', '/'], cwdRel: '.' });
    });
    expect(verifyEvidenceBundle(b).ok).toBe(false);
  });

  it('rejects an unrecognised schema version', () => {
    const b = tampered((x) => {
      (x as { schemaVersion: number }).schemaVersion = 2;
    });
    expect(verifyEvidenceBundle(b).ok).toBe(false);
  });

  it('accepts an untouched bundle round-tripped through JSON', () => {
    const clone = JSON.parse(JSON.stringify(buildEvidenceBundle(baseInput()))) as EvidenceBundleV1;
    expect(verifyEvidenceBundle(clone)).toEqual({ ok: true });
  });

  it('computeManifestSha256 ignores JS key insertion order', () => {
    const unsealedA = { a: 1, b: { c: 2, d: 3 } };
    const unsealedB = { b: { d: 3, c: 2 }, a: 1 };
    expect(computeManifestSha256(unsealedA as never)).toBe(computeManifestSha256(unsealedB as never));
  });
});

describe('isCitationSupported', () => {
  const bundle = buildEvidenceBundle(baseInput());
  const goodCitation = {
    path: 'src/thing.ts',
    startLine: 2,
    endLine: 3,
    sha256: hashLineRange(FILE_CONTENT, 2, 3),
  };

  it('supports a citation matching a verified range', () => {
    expect(isCitationSupported(bundle, goodCitation)).toEqual({ ok: true });
  });

  it('accepts the same citation written with Windows separators', () => {
    expect(isCitationSupported(bundle, { ...goodCitation, path: 'src\\thing.ts' })).toEqual({ ok: true });
  });

  // The plan's explicit provenance requirement: "modify a cited file/hash/line
  // and require the claim to become unsupported."
  it('rejects a citation whose content hash no longer matches', () => {
    const edited = FILE_CONTENT.replace('line two', 'line two (edited)');
    const verdict = isCitationSupported(bundle, { ...goodCitation, sha256: hashLineRange(edited, 2, 3) });
    expect(verdict.ok).toBe(false);
  });

  it('rejects a citation to a line range nobody verified', () => {
    expect(isCitationSupported(bundle, { ...goodCitation, startLine: 1, endLine: 4 }).ok).toBe(false);
  });

  it('reports an absolute citation path as unsupported rather than throwing', () => {
    // A citation is untrusted provider output, so a malformed path must not
    // crash the verifier.
    const verdict = isCitationSupported(bundle, { ...goodCitation, path: 'C:\\Users\\someone\\a.ts' });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/project-relative/);
  });

  it('rejects a citation to a file outside the bundle', () => {
    expect(isCitationSupported(bundle, { ...goodCitation, path: 'src/elsewhere.ts' }).ok).toBe(false);
  });

  it('rejects every citation once the bundle itself fails verification', () => {
    const clone = JSON.parse(JSON.stringify(bundle)) as EvidenceBundleV1;
    clone.provenance.baseSha = 'tampered';
    const verdict = isCitationSupported(clone, goodCitation);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('manifest hash mismatch');
  });

  it('rejects a citation to a file recorded as deleted', () => {
    const input = baseInput();
    input.files = [{ path: 'src/thing.ts', sha256: '', bytes: 0, status: 'deleted' }];
    const deletedBundle = buildEvidenceBundle(input);
    expect(isCitationSupported(deletedBundle, goodCitation).ok).toBe(false);
  });
});
