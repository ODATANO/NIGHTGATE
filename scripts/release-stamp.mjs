// Remembers which source tree passed check:release, so prepublishOnly skips a second run on the same tree.
// Run: node scripts/release-stamp.mjs start | pass | verified
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = join('node_modules', '.cache', 'nightgate-release-check');
const STARTED = join(DIR, 'started');
const PASSED = join(DIR, 'passed');

/** Hash of the working tree as a commit would hold it: tracked and untracked files, ignored ones left out. */
function treeHash() {
    const gitIndex = execFileSync('git', ['rev-parse', '--git-path', 'index'], { encoding: 'utf8' }).trim();
    const index = join(tmpdir(), `nightgate-stamp-index-${process.pid}`);
    copyFileSync(gitIndex, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
        execFileSync('git', ['-c', 'core.safecrlf=false', 'add', '-A'], { env });
        return execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim();
    } finally {
        rmSync(index, { force: true });
    }
}

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
const mode = process.argv[2];

if (mode === 'start') {
    mkdirSync(DIR, { recursive: true });
    rmSync(PASSED, { force: true });
    writeFileSync(STARTED, treeHash());
} else if (mode === 'pass') {
    const tree = treeHash();
    // A file changed while the checks ran, so they did not see this tree.
    if (read(STARTED) !== tree) {
        console.log('release-stamp: the tree changed during check:release, no stamp written');
    } else {
        writeFileSync(PASSED, tree);
        console.log(`release-stamp: tree ${tree.slice(0, 12)} passed check:release`);
    }
} else if (mode === 'verified') {
    let passed = false;
    try {
        passed = read(PASSED) !== '' && read(PASSED) === treeHash();
    } catch {
        passed = false;
    }
    console.log(passed
        ? 'release-stamp: this tree already passed check:release, not running it again'
        : 'release-stamp: this tree has not passed check:release, running it');
    process.exit(passed ? 0 : 1);
} else {
    console.error('usage: node scripts/release-stamp.mjs start | pass | verified');
    process.exit(2);
}
