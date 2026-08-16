const fs = require('fs');
const path = require('path');

const roots = ['src', 'srv'];
const generatedSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];

// A file is BUILD OUTPUT only when its TypeScript source sits next to it:
// tsc emits foo.js / foo.js.map / foo.d.ts / foo.d.ts.map from foo.ts. Files
// without that source are hand-written and must survive (src/browser ships
// hand-written declarations like index.d.ts and witnesses.d.ts next to .mjs
// modules; deleting those left the tree without browser types until the next
// checkout, and a pack from such a tree shipped an untyped package).
function shouldDelete(filePath) {
    const suffix = generatedSuffixes.find((s) => filePath.endsWith(s));
    if (!suffix) return false;
    const source = filePath.slice(0, -suffix.length) + '.ts';
    return fs.existsSync(source);
}

function walk(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return;
    }

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            walk(fullPath);
            continue;
        }

        if (shouldDelete(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    }
}

for (const root of roots) {
    walk(path.join(__dirname, '..', root));
}

console.log('Clean complete');