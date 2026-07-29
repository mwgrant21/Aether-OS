const FILE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);

function stringField(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

export function derivePermissionEditableField(toolName: string, toolInput: unknown): { label: string; value: string } | null {
  if (toolName === 'Bash') {
    const command = stringField(toolInput, 'command');
    return command === null ? null : { label: 'command', value: command };
  }
  if (FILE_PATH_TOOLS.has(toolName)) {
    const filePath = stringField(toolInput, 'file_path');
    return filePath === null ? null : { label: 'file path', value: filePath };
  }
  return null;
}
