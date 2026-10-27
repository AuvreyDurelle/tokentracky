/** GitHub's link to the newest published release's DMG. Drafts are never latest, so it only serves a finished release. */
export const MAC_DOWNLOAD_URL = 'https://github.com/AuvreyDurelle/tokentracky/releases/latest/download/Tokentracky.dmg';

/** The download link when this deploy sets exactly `true`, else null: then pages say the app is coming soon. */
export function macDownloadUrl(enabled: string | undefined): string | null {
  return enabled === 'true' ? MAC_DOWNLOAD_URL : null;
}

export const MAC_DOWNLOAD = macDownloadUrl(import.meta.env.VITE_MACOS_DOWNLOAD_ENABLED);

/** The terminal install when this deploy sets exactly `true`, else null: only once the npm launcher is published. It fetches the checked CLI and starts the browser approval (Mac delivery plan D7). */
export function installCommand(enabled: string | undefined): string | null {
  return enabled === 'true' ? 'npx tokentracky login' : null;
}

export const INSTALL_COMMAND = installCommand(import.meta.env.VITE_NPM_INSTALL_ENABLED);
