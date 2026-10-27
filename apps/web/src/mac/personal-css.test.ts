import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./personal.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = [...css.replace(/@media[^{]+\{/g, '').matchAll(/(?:^|[{};])\s*([^{};@]+)\{/g)].flatMap((match) => match[1]!.split(',').map((selector) => selector.trim()));

describe('personal.css', () => {
  it('scopes every rule under .mac, starting from a class of the Tokens, Settings or popover page', () => {
    expect(selectors.length).toBeGreaterThan(30);
    // `.mac .tk-x …`, or `.mac.po-x …` for the popover's own root.
    for (const selector of selectors) expect(selector).toMatch(/^\.mac(?:\.(?:tk|st|po)-[\w-]+(?:[ .:>[]|$)| \.(?:tk|st|po)-[\w-]+(?![\w-]))/);
  });
});
