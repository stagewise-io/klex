import { isAbsolute, resolve } from 'node:path';

export class MachinePathResolver {
  constructor(readonly defaultCwd: string) {}

  resolve(path: string): string {
    if (path.length === 0) throw new Error('Path must not be empty');
    return isAbsolute(path) ? resolve(path) : resolve(this.defaultCwd, path);
  }
}
