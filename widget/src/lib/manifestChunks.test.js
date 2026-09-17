import test from 'node:test';
import assert from 'node:assert/strict';

import { chunksFromManifest } from './manifestChunks.js';

// Shape of the production manifest (cssCodeSplit off, entry re-exports two chunks).
const MANIFEST = {
    'src/app-entry.jsx': {
        file: 'oyechats-app.CrxvppYa.js',
        isEntry: true,
        imports: ['_oyechats-vendor.BM6KkRkp.js', '_oyechats-app-entry.r4Y62n4w.js'],
    },
    '_oyechats-vendor.BM6KkRkp.js': { file: 'oyechats-vendor.BM6KkRkp.js' },
    '_oyechats-app-entry.r4Y62n4w.js': { file: 'oyechats-app-entry.r4Y62n4w.js' },
    'style.css': { file: 'oyechats-app.nn35efKq.css', src: 'style.css' },
};

test('resolves the entry, its eager imports and the stylesheet', () => {
    assert.deepEqual(chunksFromManifest(MANIFEST), {
        entry: 'oyechats-app.CrxvppYa.js',
        imports: ['oyechats-vendor.BM6KkRkp.js', 'oyechats-app-entry.r4Y62n4w.js'],
        css: 'oyechats-app.nn35efKq.css',
    });
});

test('prefers the css listed on the entry when the build splits css', () => {
    const manifest = {
        ...MANIFEST,
        'src/app-entry.jsx': { ...MANIFEST['src/app-entry.jsx'], css: ['oyechats-app.split.css'] },
    };
    assert.equal(chunksFromManifest(manifest).css, 'oyechats-app.split.css');
});

test('a build without a stylesheet resolves css to null', () => {
    const { 'style.css': _omitted, ...manifest } = MANIFEST;
    assert.equal(chunksFromManifest(manifest).css, null);
});

test('a manifest without the app entry is rejected', () => {
    assert.throws(() => chunksFromManifest({}), /missing entry chunk/);
    assert.throws(() => chunksFromManifest(null), /missing entry chunk/);
});

test('an import key the manifest does not define is rejected', () => {
    const manifest = {
        ...MANIFEST,
        'src/app-entry.jsx': { file: 'oyechats-app.x.js', imports: ['_missing.js'] },
    };
    assert.throws(() => chunksFromManifest(manifest), /unknown chunk: _missing\.js/);
});

test('a filename that could leave the app directory is rejected', () => {
    for (const bad of ['../evil.js', 'https://evil.example/x.js', 'a/b.js', '']) {
        const entryOnly = { 'src/app-entry.jsx': { file: bad } };
        assert.throws(() => chunksFromManifest(entryOnly), /unsafe filename|missing entry chunk/, bad);
    }
    const badCss = { ...MANIFEST, 'style.css': { file: '../x.css' } };
    assert.throws(() => chunksFromManifest(badCss), /unsafe filename/);
    const badImport = { ...MANIFEST, '_oyechats-vendor.BM6KkRkp.js': { file: '//evil/x.js' } };
    assert.throws(() => chunksFromManifest(badImport), /unsafe filename/);
});
