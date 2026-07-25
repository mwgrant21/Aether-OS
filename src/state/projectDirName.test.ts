import { describe, expect, it } from 'vitest';
import { cwdToProjectDirName } from './projectDirName';

describe('cwdToProjectDirName', () => {
  it('replaces drive colon, backslashes, and dots with hyphens', () => {
    expect(cwdToProjectDirName('C:\\Users\\Matt')).toBe('C--Users-Matt');
  });

  it('replaces dotfile segments the same as path separators', () => {
    expect(cwdToProjectDirName('C:\\Users\\IT\\.claude')).toBe('C--Users-IT--claude');
  });

  it('leaves a path with no special characters unchanged', () => {
    expect(cwdToProjectDirName('home')).toBe('home');
  });
});
