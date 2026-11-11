// Images in a paste. A terminal can only receive text, but the thing on
// the owner's clipboard after a screenshot is a bitmap, so pasting one into a
// pane means: upload the image to the box through the existing inbox, then
// paste the resulting absolute path as text for the claude session to read.
// This module is only the decision of WHAT was pasted; the pane does the rest.

/** The subset of DataTransferItem the decision needs, for tests. */
export interface PastedItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/**
 * The image files a paste should be treated as, or empty to leave the paste
 * alone. Text wins over images: a copy from Excel or Word carries both a
 * text and a bitmap rendering, and pasting a picture of cells where their
 * text was wanted would be absurd. A screenshot is image-only, which is
 * exactly the case this exists for.
 */
export function pastedImages(items: readonly PastedItem[], plainText: string): File[] {
  if (plainText.trim().length > 0) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * Clipboard images arrive named "image.png", every single one. Give the inbox
 * a name a human can tell apart on the Uploads card and in a claude prompt.
 */
export function screenshotName(file: File, now: Date = new Date()): string {
  const ext = (file.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `screenshot-${stamp}-${time}.${ext}`;
}
