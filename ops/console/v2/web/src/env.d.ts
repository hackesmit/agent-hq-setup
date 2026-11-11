/// <reference types="vite/client" />

// Ambient declarations (no import/export in this file, so everything here is global).

interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Per-boot CSRF key injected into index.html by the console server. */
  __CONSOLE_BOOT_KEY__?: string;
}
