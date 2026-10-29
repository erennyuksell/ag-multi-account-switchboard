#!/usr/bin/env node
// End-to-end account switch checks against the running IDE, through the dev
// control channel. Switches real accounts and restarts agent hubs: every
// window's running agent is interrupted.
//
//   node scripts/agdev-e2e.mjs <accountA> <accountB> <accountC>

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const AGDEV = path.join(path.dirname(new URL(import.meta.url).pathname), 'agdev.mjs');
const [A, B, C] = process.argv.slice(2);
if (!C) { console.error('usage: agdev-e2e.mjs <accountA> <accountB> <accountC>'); process.exit(2); }

const run = (...args) => JSON.parse(execFileSync('node', [AGDEV, ...args], { encoding: 'utf8', maxBuffer: 1 << 24 }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = e => (e || '-').split('@')[0];

async function settled(target, timeoutMs = 30_000) {
    const start = Date.now();
    for (;;) {
        const states = run('send', 'state', '--target', 'all', '--timeout', '20');
        const servers = states[0]?.result?.servers ?? [];
        const panels = states.map(s => s.result.panel);
        const ok = servers.length > 0 && servers.every(s => s.email === target)
            && panels.every(p => p.lastActiveEmail === target && p.localEmail === target && !p.switching);
        if (ok || Date.now() - start > timeoutMs) {
            return { ok, after: Date.now() - start, servers: servers.map(s => short(s.email)), panels: panels.map(p => `${short(p.lastActiveEmail)}/${short(p.localEmail)}`) };
        }
        await sleep(1000);
    }
}

const execFileAsync = promisify(execFile);
async function switchOn(target, email, timeout = 80) {
    const t0 = Date.now();
    const { stdout } = await execFileAsync('node', [AGDEV, 'send', 'switch', '--target', target, '--email', email, '--timeout', String(timeout)], { maxBuffer: 1 << 24 });
    const r = JSON.parse(stdout);
    return { result: r[0]?.result, ok: r[0]?.ok, ms: Date.now() - t0, window: r[0]?.workspace };
}

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`); };

// Instance ids change whenever an extension host restarts, so look them up per step.
const win = i => run('windows').sort((a, b) => a.workspace.localeCompare(b.workspace))[i].instanceId;
if (run('windows').length < 2) { console.error('need at least two IDE windows'); process.exit(2); }

// 1. Plain switch.
let s = await switchOn(win(0), A);
let st = await settled(A);
check('switch confirms', s.ok && s.result?.confirmed === true, s);
check('every hub and panel on target', st.ok, st);

// 2. Same account again.
s = await switchOn(win(0), A);
check('no-op is reported as already active', s.result?.alreadyActive === true && s.ms < 5000, s);

// 3. Two windows switch 1.5s apart: the first must give way, the second wins.
const first = switchOn(win(0), B);
await sleep(1500);
const second = await switchOn(win(1), C);
const firstResult = await first;
st = await settled(C);
check('earlier switch yields to later one', firstResult.result?.confirmed === false && firstResult.ms < 20_000, firstResult);
check('later switch confirms', second.result?.confirmed === true, second);
check('every hub and panel on the later target', st.ok, st);

// 4. Third hub restart inside 10 minutes: falls back to restarting extension hosts.
s = await switchOn(win(1), A, 90);
await sleep(8000); // extension hosts restart
st = await settled(A, 45_000);
check('switch past the restart budget still lands', st.ok, { switch: s, state: st });

const failed = results.filter(r => !r.pass).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
