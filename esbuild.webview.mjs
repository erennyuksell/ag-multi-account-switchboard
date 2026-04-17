/**
 * esbuild config for the webview bundle.
 * Compiles src/webview/main.ts → out/webview/panel.js (browser IIFE)
 * Also copies panel.css to out/webview/
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

// Ensure output directory exists
const outDir = resolve(__dirname, 'out/webview');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// Copy CSS (not bundled by esbuild — loaded separately via <link>)
copyFileSync(
    resolve(__dirname, 'src/webview/panel.css'),
    resolve(outDir, 'panel.css')
);
console.log('[webview] panel.css → out/webview/panel.css');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: [resolve(__dirname, 'src/webview/main.ts')],
    bundle: true,
    outfile: resolve(outDir, 'panel.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: isProduction,
    sourcemap: !isProduction,
    tsconfig: resolve(__dirname, 'tsconfig.webview.json'),
};

if (isWatch) {
    const ctx = await (await import('esbuild')).context(buildOptions);
    await ctx.watch();
    console.log('[webview] watching for changes...');
} else {
    await build(buildOptions);
    console.log('[webview] bundle → out/webview/panel.js' + (isProduction ? ' (minified)' : ''));
}
