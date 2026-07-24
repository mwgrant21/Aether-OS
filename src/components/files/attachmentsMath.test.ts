import { describe, expect, it } from 'vitest';
import { resolveCollisionName, formatFileSize, isImageExtension } from './attachmentsMath';

describe('resolveCollisionName', () => {
  it('returns the desired name unchanged when it does not collide', () => {
    expect(resolveCollisionName(['other.png'], 'screenshot.png')).toBe('screenshot.png');
  });

  it('appends " (2)" before the extension on a first collision', () => {
    expect(resolveCollisionName(['screenshot.png'], 'screenshot.png')).toBe('screenshot (2).png');
  });

  it('appends " (3)" when " (2)" is already taken', () => {
    expect(resolveCollisionName(['screenshot.png', 'screenshot (2).png'], 'screenshot.png')).toBe('screenshot (3).png');
  });

  it('handles a name with no extension', () => {
    expect(resolveCollisionName(['README'], 'README')).toBe('README (2)');
  });
});

describe('formatFileSize', () => {
  it('formats 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats a byte count just under 1 KB', () => {
    expect(formatFileSize(999)).toBe('999 B');
  });

  it('formats exactly 1 KB', () => {
    expect(formatFileSize(1000)).toBe('1.0 KB');
  });

  it('formats exactly 1 MB', () => {
    expect(formatFileSize(1_000_000)).toBe('1.0 MB');
  });
});

describe('isImageExtension', () => {
  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])('is true for .%s (case-insensitive)', (ext) => {
    expect(isImageExtension(`photo.${ext}`)).toBe(true);
    expect(isImageExtension(`photo.${ext.toUpperCase()}`)).toBe(true);
  });

  it('is false for a non-image extension', () => {
    expect(isImageExtension('notes.txt')).toBe(false);
  });

  it('is false for a name with no extension', () => {
    expect(isImageExtension('README')).toBe(false);
  });
});
