// The compose file's default image tag must follow the release: a stale
// default pulls the previous image after a version bump.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('docker/docker-compose.yml image tag', () => {
    it('defaults NIGHTGATE_IMAGE_TAG to the package version', () => {
        const compose = fs.readFileSync(path.resolve(__dirname, '../../docker/docker-compose.yml'), 'utf8');
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
        const m = compose.match(/image: ghcr\.io\/odatano\/nightgate:\$\{NIGHTGATE_IMAGE_TAG:-([^}]+)\}/);
        expect(m, 'nightgate image line with a NIGHTGATE_IMAGE_TAG default').toBeTruthy();
        expect(m![1]).toBe(pkg.version);
    });
});
