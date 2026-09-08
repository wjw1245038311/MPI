/** Node ESM loader: retry extensionless relative imports with a .ts suffix so
 * source files written for the bundler (extensionless) can be tested directly. */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
