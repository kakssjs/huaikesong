export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Node's fetch ignores HTTP(S)_PROXY unless asked. On a PC that needs a proxy to reach
    // Agnes, image generation then fails with "fetch failed" (connect timeout).
    // No-op when no proxy is set or the Node version lacks the function.
    const http = await import('node:http');
    (http as { setGlobalProxyFromEnv?: () => void }).setGlobalProxyFromEnv?.();

    const { startRunner } = await import('./lib/runner');
    startRunner();

    // Real contracts need an e-signature provider and a payment provider. None is bundled: a deployment points
    // CONTRACT_PROVIDER_MODULE at its own adapter module exporting `signing` and/or `payment` (interfaces in
    // packages/shared/src/contract-providers.ts). Without it, real signing and money actions answer 503.
    const providerModule = process.env.CONTRACT_PROVIDER_MODULE?.trim();
    if (providerModule) {
      const path = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { registerContractProviders } = await import('@i-renovation/shared/contract-providers');
      try {
        const loaded = await import(/* webpackIgnore: true */ pathToFileURL(path.resolve(providerModule)).href);
        const mod = (loaded.default ?? loaded) as { signing?: unknown; payment?: unknown };
        registerContractProviders({ signing: mod.signing as never, payment: mod.payment as never });
        console.log(`[contract-provider] registered${mod.signing ? ' signing' : ''}${mod.payment ? ' payment' : ''} provider(s) from ${providerModule}`);
      } catch (error) {
        // Fail loudly but keep the site up: real contract actions stay refused instead of pretending to work.
        console.error('[contract-provider] could not load CONTRACT_PROVIDER_MODULE; real signing and payments stay unavailable:', (error as Error).message);
      }
    }
  }
}
