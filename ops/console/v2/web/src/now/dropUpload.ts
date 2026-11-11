// Files dragged from the PC onto a terminal pane. Each file goes through the same
// inbox upload as a pasted screenshot; the server-returned absolute paths are then
// pasted as one bracketed paste. Dropped file names are untrusted text, so only the
// path the server returns is ever pasted (quoted when it needs it).

/** Quote one path for a shell when it holds a space, quote or other special character. */
export function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The text to paste for the uploaded paths: space separated, quoted, no Enter. */
export function pasteText(paths: readonly string[]): string {
  return paths.map(shellQuote).join(" ");
}

/** Minimal slice of DataTransferItem the drop decision needs. */
export interface DropItem {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?(): { isDirectory: boolean } | null;
}

/** Files to upload, plus how many dropped entries were folders (not supported). */
export function droppedFiles(items: readonly DropItem[]): { files: File[]; folders: number } {
  const files: File[] = [];
  let folders = 0;
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      folders += 1;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}

/**
 * Upload each file in order (a refused file is the uploader's null; the rest still go),
 * then return the text to paste, or null when nothing uploaded.
 */
export async function runDrop(
  files: readonly File[],
  upload: (file: File) => Promise<string | null>,
): Promise<string | null> {
  const paths: string[] = [];
  for (const file of files) {
    const path = await upload(file);
    if (path) paths.push(path);
  }
  return paths.length > 0 ? `${pasteText(paths)} ` : null;
}
