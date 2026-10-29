// @vitest-environment node
// The frontend CI runs on Ubuntu. Keep packaging provenance checks in its
// existing test suite, including frontend-only installs and Git-free archives.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

it('stamps the actual clean/modified source and validates archive revisions', () => {
    const script = fileURLToPath(
        new URL('../../backend/tests/test_frontend_build.py', import.meta.url),
    );
    expect(() => execFileSync('python3', [script], { stdio: 'pipe' })).not.toThrow();
}, 20000);
