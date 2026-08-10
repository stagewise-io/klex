export function resolveSigningMode(environment = process.env) {
  return /^(1|true|yes)$/i.test(environment.WINDOWS_SIGNING_REQUIRED ?? '')
    ? 'required'
    : 'optional';
}

export function createAppPackagerConfig(environment = process.env) {
  return {
    name: 'stagewise-windows-use',
    entry: 'dist/main.js',
    outputDirectory: 'dist',
    useCodeCache: true,
    signing: { mode: resolveSigningMode(environment) },
  };
}

export default createAppPackagerConfig();
