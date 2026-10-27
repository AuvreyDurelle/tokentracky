import {URL} from 'node:url';
import {build} from 'esbuild';
import {cp, readFile} from 'node:fs/promises';
const pkg=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
await build({entryPoints:['src/main.ts'],outfile:'dist/main.mjs',bundle:true,platform:'node',target:'node22',format:'esm',external:Object.keys(pkg.dependencies).filter(name=>!name.startsWith('@tokentracky/')),sourcemap:true});
// Hosted mode applies the cloud schema from these plain SQL files at startup.
await cp(new URL('../../packages/cloud/migrations/',import.meta.url),new URL('./dist/migrations/',import.meta.url),{recursive:true});
