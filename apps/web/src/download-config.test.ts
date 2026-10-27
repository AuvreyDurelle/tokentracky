import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installCommand, MAC_DOWNLOAD_URL, macDownloadUrl } from './download-config';

describe('website Mac download configuration', () => {
  it('links the latest release’s fixed-name DMG only when the deploy turns it on', () => {
    expect(macDownloadUrl('true')).toBe('https://github.com/AuvreyDurelle/tokentracky/releases/latest/download/Tokentracky.dmg');
    for (const off of [undefined, '', 'false', 'TRUE', '1', 'yes']) expect(macDownloadUrl(off)).toBeNull();
  });

  it('offers the npx command only when the deploy turns it on', () => {
    expect(installCommand('true')).toBe('npx tokentracky login');
    for (const off of [undefined, '', 'false', 'TRUE', '1', 'yes']) expect(installCommand(off)).toBeNull();
  });

  it('names the asset the release workflow uploads', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/release-macos.yml', import.meta.url), 'utf8');
    expect(workflow).toContain(`dist/public/${MAC_DOWNLOAD_URL.split('/').at(-1)}`);
  });
});
