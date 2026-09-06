import fs from 'fs';
import path from 'path';

const html = fs.readFileSync('./index.html', 'utf-8');
const matches = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

const localPaths = [...new Set(matches)].filter((p) => p.startsWith('/') && !p.startsWith('//'));

console.log(`Found ${localPaths.length} local paths to check...`);

for (const p of localPaths) {
    const rootPath = path.join('.', p);
    const publicPath = path.join('./public', p);

    for (const candidate of [rootPath, publicPath]) {
        if (fs.existsSync(candidate)) {
            const stat = fs.statSync(candidate);
            if (stat.isDirectory()) {
                console.log('DIRECTORY (should be a file): ' + p + ' -> ' + candidate);
            }
        }
    }
}

console.log('Done checking.');
