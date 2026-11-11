// A pasted screenshot, uploaded. Shared by the terminal pane and the request answer
// box: both can only carry text to a worker, so the bitmap goes through the inbox
// (same store and same refusals as drag-and-drop) and what comes back is the
// absolute path on the box for the worker to read.

import { screenshotName } from "./clipboardImages";
import { hashFile } from "./sha256";
import { toastError, toastInfo } from "./toast";
import { newUploadId, uploadFile } from "./uploadApi";
import { rejectReason } from "./uploadMachine";

/** Upload one pasted image; the path on the box, or null after a toast saying why not. */
export async function uploadPastedImage(image: File): Promise<string | null> {
  return uploadAnyFile(new File([image], screenshotName(image), { type: image.type }));
}

/** Upload any file under its own name; the path on the box, or null after a toast saying why not. */
export async function uploadAnyFile(named: File): Promise<string | null> {  // the same refusal the queue applies, BEFORE hashing: a rejected file
  // must not cost a full read of itself first
  const refused = rejectReason(named);
  if (refused) {
    toastError(refused);
    return null;
  }
  try {
    toastInfo(`uploading ${named.name} to the box`);
    const hashed = await hashFile(named);
    const result = await uploadFile(named, newUploadId(), hashed.hex);
    return result.path;
  } catch (err) {
    toastError(err instanceof Error ? err.message : "upload failed");
    return null;
  }
}
