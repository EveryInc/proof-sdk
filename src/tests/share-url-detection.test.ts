function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const prevWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = {
      location: {
        origin: 'http://localhost:5555',
        pathname: '/d/test-slug',
        search: '',
      },
      __PROOF_CONFIG__: {},
    };

    const mod = await import('../bridge/share-client.ts');
    const shareClient = mod.shareClient as { refreshRuntimeConfig: () => boolean; isShareMode: () => boolean; getSlug: () => string | null };

    // `/d/:slug` is share mode.
    (globalThis as any).window.location.pathname = '/d/test-slug';
    assert(shareClient.refreshRuntimeConfig() === true, 'Expected refreshRuntimeConfig true for /d/:slug');
    assert(shareClient.isShareMode() === true, 'Expected isShareMode true for /d/:slug');
    assert(shareClient.getSlug() === 'test-slug', 'Expected slug to parse from /d/:slug');

    // `/d/:slug/` (trailing slash) should behave the same.
    (globalThis as any).window.location.pathname = '/d/test-slug/';
    assert(shareClient.refreshRuntimeConfig() === true, 'Expected refreshRuntimeConfig true for /d/:slug/ trailing slash');
    assert(shareClient.isShareMode() === true, 'Expected isShareMode true for /d/:slug/ trailing slash');
    assert(shareClient.getSlug() === 'test-slug', 'Expected slug to parse from /d/:slug/ trailing slash');

    // `/d/:slug/bridge` should not be treated as share mode (bridge route).
    (globalThis as any).window.location.pathname = '/d/test-slug/bridge';
    (globalThis as any).window.__PROOF_CONFIG__ = {};
    shareClient.refreshRuntimeConfig();
    assert(shareClient.isShareMode() === false, 'Expected isShareMode false for /d/:slug/bridge');
    assert(shareClient.getSlug() === null, 'Expected slug null for /d/:slug/bridge');

    console.log('✓ share URL detection handles trailing slash');
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
