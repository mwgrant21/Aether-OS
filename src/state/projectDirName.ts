export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[:\\.]/g, '-');
}
