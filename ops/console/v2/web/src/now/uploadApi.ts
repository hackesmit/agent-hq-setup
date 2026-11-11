// The upload request itself.
//
// XMLHttpRequest rather than fetch, for one reason: fetch cannot report upload progress,
// and a 200 MB file over the tailnet without a bar looks hung. Everything else follows the
// contract: one file per request in a multipart field named "file", the client id and the
// declared size and sha256 in headers, and the CSRF key like any other POST.

import type { UploadResult } from "@shared/api";
import { API_BASE, bootKey } from "../data/client";
import { mapUploadError, type UploadFailure } from "./uploadMachine";

export class UploadError extends Error {
  readonly status: number;
  readonly failure: UploadFailure;
  constructor(status: number, detail: string | null) {
    const failure = mapUploadError(status, detail);
    super(failure.error);
    this.name = "UploadError";
    this.status = status;
    this.failure = failure;
  }
}

/** A client-generated upload id (idempotency key), uuid when the browser offers one. */
export function newUploadId(): string {
  const cryptoRef = typeof globalThis === "undefined" ? undefined : globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoRef.getRandomValues(bytes);
    bytes[6] = ((bytes[6]! & 0x0f) | 0x40) as number;
    bytes[8] = ((bytes[8]! & 0x3f) | 0x80) as number;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function detailOf(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // plain text body
  }
  return raw.slice(0, 200);
}

export interface UploadOptions {
  onProgress?: (bytesSent: number) => void;
  /** Called with the abort handle so a row can cancel an in-flight request. */
  onStart?: (abort: () => void) => void;
}

/**
 * Send one file. Resolves with the committed row (201) or with the existing row when the
 * server recognises the id and the declared size and hash match (200, a retry after a lost
 * response). Rejects with an UploadError carrying the mapped, human-readable reason.
 */
export function uploadFile(
  file: File,
  id: string,
  sha256: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/upload`, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Console-Key", bootKey());
    xhr.setRequestHeader("X-Upload-Id", id);
    xhr.setRequestHeader("X-Upload-Size", String(file.size));
    xhr.setRequestHeader("X-Upload-Sha256", sha256);

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded);
    };
    xhr.onerror = () => reject(new UploadError(0, null));
    xhr.ontimeout = () => reject(new UploadError(0, "timed out"));
    xhr.onabort = () => reject(new UploadError(0, "cancelled"));
    xhr.onload = () => {
      const raw = typeof xhr.responseText === "string" ? xhr.responseText : "";
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(raw) as UploadResult);
        } catch {
          reject(new UploadError(xhr.status, "the server returned an unreadable upload record"));
        }
        return;
      }
      reject(new UploadError(xhr.status, detailOf(raw)));
    };

    options.onStart?.(() => xhr.abort());
    xhr.send(form);
  });
}

/** YYYY-MM-DD in local time, the key GET /api/uploads takes. */
export function todayStamp(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
