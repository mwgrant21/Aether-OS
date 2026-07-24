import { dialog, shell } from 'electron';
import { promises as fs } from 'fs';
import { join, basename, extname } from 'path';
import { resolveCollisionName, isImageExtension, type AttachmentInfo } from '../src/components/files/attachmentsMath';

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function assertSafeName(name: string): void {
  if (name !== basename(name)) {
    throw new Error('invalid attachment name');
  }
}

export function createAttachmentsStore(dir: string) {
  return {
    async list(): Promise<AttachmentInfo[]> {
      await ensureDir(dir);
      const names = await fs.readdir(dir);
      const infos = await Promise.all(
        names.map(async (name) => {
          const stat = await fs.stat(join(dir, name));
          return { name, size: stat.size, mtimeMs: stat.mtimeMs };
        }),
      );
      return infos.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },

    async add(): Promise<string[]> {
      await ensureDir(dir);
      const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return [];
      const namesSoFar = await fs.readdir(dir);
      const written: string[] = [];
      for (const srcPath of result.filePaths) {
        const finalName = resolveCollisionName(namesSoFar, basename(srcPath));
        namesSoFar.push(finalName);
        await fs.copyFile(srcPath, join(dir, finalName));
        written.push(finalName);
      }
      return written;
    },

    async remove(name: string): Promise<void> {
      assertSafeName(name);
      await fs.unlink(join(dir, name));
    },

    async thumbnail(name: string): Promise<string | null> {
      assertSafeName(name);
      if (!isImageExtension(name)) return null;
      try {
        const buf = await fs.readFile(join(dir, name));
        const ext = extname(name).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        return `data:image/${mime};base64,${buf.toString('base64')}`;
      } catch {
        return null;
      }
    },

    async open(name: string): Promise<void> {
      assertSafeName(name);
      await shell.openPath(join(dir, name));
    },
  };
}
