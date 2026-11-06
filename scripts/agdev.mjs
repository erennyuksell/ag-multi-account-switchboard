#!/usr/bin/env node
// Client for the dev control channel (src/dev/devControl.ts).
// Lets the extension be driven and observed without anyone at the keyboard.
//
//   node scripts/agdev.mjs windows
//   node scripts/agdev.mjs send <action> [--target any|all|<id>] [--email x] [--timeout 60]
//   node scripts/agdev.mjs deploy          # package, install, restart every extension host, wait for new build
//
// Requires "ag-switchboard.devControl": true in the IDE settings.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const ROOT = path.join(os.homedir(), '.ag-switchboard-dev');
const LIVE_MS = 15_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function liveWindows() {
    const dir = path.join(ROOT, 'windows');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap(n => {
        try {
            const w = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
            return Date.now() - w.heartbeatAt < LIVE_MS ? [w] : [];
        } catch { return []; }
    });
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1], i++;
        else out._.push(argv[i]);
    }
    return out;
}

async function send(action, { target = 'any', timeout = 60, ...rest } = {}) {
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
    const cmd = { id, action, args: rest, target, createdAt: Date.now() };
    const expected = target === 'all' ? liveWindows().map(w => w.instanceId) : null;
    const tmp = path.join(ROOT, `.${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cmd), { mode: 0o600 });
    fs.renameSync(tmp, path.join(ROOT, 'inbox', `${id}.json`));

    const outbox = path.join(ROOT, 'outbox');
    const deadline = Date.now() + Number(timeout) * 1000;
    const results = new Map();
    while (Date.now() < deadline) {
        for (const n of fs.readdirSync(outbox)) {
            if (!n.startsWith(id + '.') || results.has(n)) continue;
            try { results.set(n, JSON.parse(fs.readFileSync(path.join(outbox, n), 'utf8'))); } catch { /* partial write */ }
        }
        if (expected ? expected.every(w => [...results.keys()].some(k => k.endsWith(`.${w}.json`))) : results.size > 0) break;
        await sleep(250);
    }
    if (target === 'all') { try { fs.unlinkSync(path.join(ROOT, 'inbox', `${id}.json`)); } catch { /* claimed */ } }
    return [...results.values()];
}

async function deploy() {
    const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    execSync('npm run package', { cwd, stdio: 'ignore' });
    const vsix = fs.readdirSync(cwd).filter(f => f.endsWith('.vsix'))
        .map(f => ({ f, t: fs.statSync(path.join(cwd, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
    execSync(`antigravity-ide --install-extension "${path.join(cwd, vsix)}" --force`, { stdio: 'ignore' });
    const before = liveWindows();
    const restartedAt = Date.now();
    await send('restartExtensionHost', { target: 'all', timeout: 10 });
    // Wait until every window that was live has come back with a fresh activation.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const now = liveWindows();
        const fresh = now.filter(w => w.activatedAt > restartedAt);
        if (fresh.length >= before.length) {
            return { vsix, windows: fresh.map(w => ({ id: w.instanceId, ws: w.workspace, build: new Date(w.build).toISOString() })) };
        }
        await sleep(1000);
    }
    return { vsix, error: 'not every window came back within 90s', windows: liveWindows() };
}

const args = parseArgs(process.argv.slice(2));
const [verb, action] = args._;
let out;
if (verb === 'windows') out = liveWindows();
else if (verb === 'send') { const { _, ...opts } = args; out = await send(action, opts); }
else if (verb === 'deploy') out = await deploy();
else { console.error('usage: agdev windows | send <action> [--target] [--email] [--timeout] | deploy'); process.exit(2); }
console.log(JSON.stringify(out, null, 1));
