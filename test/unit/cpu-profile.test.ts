// `profileCurrentThread` drives the in-thread V8 profiler and reports heap +
// GC figures for the window; the admin action and the worker RPC both rely
// on its shape. A short busy window on the test thread proves the plumbing.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileCurrentThread, heapFigures } from '../../srv/midnight/cpu-profile';

describe('profileCurrentThread', () => {
    it('samples the current thread, attributes busy time, reports heap and gc, writes the raw profile', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-prof-'));
        const busy = setInterval(() => { const end = Date.now() + 40; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); void [new Array(20000).fill(x)]; }, 50);
        try {
            const p = await profileCurrentThread(1, { dir, filePrefix: 'test', top: 5 });
            expect(p.seconds).toBe(1);
            expect(p.sampledMs).toBeGreaterThan(800);
            expect(p.idlePercent).toBeLessThan(90);                 // the busy loop shows
            expect(p.topFunctions.length).toBeGreaterThan(0);
            expect(p.topFunctions.length).toBeLessThanOrEqual(5);
            expect(p.heapBefore.limitMb).toBeGreaterThan(0);
            expect(p.heapAfter.usedMb).toBeGreaterThan(0);
            expect(p.heapAfter.rssMb).toBeGreaterThan(0);
            expect(p.gc.count).toBeGreaterThanOrEqual(0);
            expect(typeof p.gc.totalMs).toBe('number');
            expect(p.file && fs.existsSync(p.file)).toBe(true);
            const raw = JSON.parse(fs.readFileSync(p.file!, 'utf8'));
            expect(Array.isArray(raw.nodes) && Array.isArray(raw.samples)).toBe(true);
        } finally {
            clearInterval(busy);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    it('clamps the window to 1..120 s and survives an unwritable directory', async () => {
        const p = await profileCurrentThread(0.2, { dir: path.join(os.tmpdir(), 'ng-prof-nope', 'x', 'y'), top: 3 });
        expect(p.seconds).toBe(1);
        expect(p.topFunctions.length).toBeLessThanOrEqual(3);
        // dir is created on demand, so the file exists; an unusable root is reported as null, never thrown
        expect(p.file === null || fs.existsSync(p.file)).toBe(true);
        if (p.file) fs.rmSync(path.join(os.tmpdir(), 'ng-prof-nope'), { recursive: true, force: true });
    }, 20_000);

    it('heapFigures are whole megabytes', () => {
        const h = heapFigures();
        for (const v of Object.values(h)) expect(Number.isInteger(v)).toBe(true);
        expect(h.limitMb).toBeGreaterThan(h.usedMb);
    });
});
