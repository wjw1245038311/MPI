/** Node ESM loader for tests that import main-process modules in plain node:
 * - resolves the bare `electron` specifier to ./electron-stub.mjs (the real
 *   package would resolve from node_modules and break named imports), and
 * - retries extensionless relative imports with a .ts suffix so bundler-style
 *   sources load directly (same behavior as ts-ext-loader.mjs, inlined here so
 *   this single loader is self-contained regardless of registration order). */
const ELECTRON_STUB = new URL("./electron-stub.mjs", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    return { url: ELECTRON_STUB.href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
