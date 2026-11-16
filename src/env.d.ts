/// <reference types="vite/client" />

declare module '*.png' {
  const value: any;
  export default value;
}

interface ImportMetaEnv {
  readonly VITE_LEGACY_FIREBASE?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
