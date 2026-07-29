import { describe, it, expect } from 'vitest';
import { derivePermissionEditableField } from './permissionEditableField';

describe('derivePermissionEditableField', () => {
  it('returns the command field for Bash', () => {
    expect(derivePermissionEditableField('Bash', { command: 'rm -rf x' })).toEqual({ label: 'command', value: 'rm -rf x' });
  });

  it('returns the file path field for Read/Write/Edit/NotebookEdit', () => {
    for (const toolName of ['Read', 'Write', 'Edit', 'NotebookEdit']) {
      expect(derivePermissionEditableField(toolName, { file_path: 'src/foo.ts' })).toEqual({ label: 'file path', value: 'src/foo.ts' });
    }
  });

  it('returns null for other tools', () => {
    expect(derivePermissionEditableField('Grep', { pattern: 'x' })).toBeNull();
  });

  it('returns null when the expected field is missing or not a string', () => {
    expect(derivePermissionEditableField('Bash', {})).toBeNull();
    expect(derivePermissionEditableField('Bash', { command: 42 })).toBeNull();
    expect(derivePermissionEditableField('Read', null)).toBeNull();
  });
});
