export function createDiscoveryPolicy(configuration: unknown): {
  includes(surface: string, route: string): boolean;
};
