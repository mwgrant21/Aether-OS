export interface AttachmentInfo {
  name: string;
  size: number;
  mtimeMs: number;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function splitExt(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

export function resolveCollisionName(existingNames: string[], desiredName: string): string {
  if (!existingNames.includes(desiredName)) return desiredName;
  const { base, ext } = splitExt(desiredName);
  let n = 2;
  let candidate = `${base} (${n})${ext}`;
  while (existingNames.includes(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function isImageExtension(name: string): boolean {
  const { ext } = splitExt(name);
  return IMAGE_EXTENSIONS.has(ext.slice(1).toLowerCase());
}
