const fs = require('fs');
const path = require('path');

const roots = ['src', 'srv'];
const generatedSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];

function shouldDelete(filePath) {
    return generatedSuffixes.some((suffix) => filePath.endsWith(suffix));
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