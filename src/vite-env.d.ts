declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.webp" {
  const src: string;
  export default src;
}

declare const __TAURI_VERSION__: string;
declare const __APP_VERSION__: string;
declare const __BUILD_MODE__: "dev" | "release";

interface Window {
  __TAURI__?: {
    event?: {
      listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
    };
  };
  __blackopsToasts?: {
    addToast: (message: string, type?: string, duration?: number) => void;
  };
}
