class DiscoveryPolicy {
  constructor(configuration) {
    const allowed = new Set(['sitemap', 'agents', 'markdown']);
    if (
      !configuration ||
      typeof configuration !== 'object' ||
      Array.isArray(configuration)
    )
      throw new Error('Discovery policy must be an object');
    for (const [surface, patterns] of Object.entries(configuration)) {
      if (
        !allowed.has(surface) ||
        !Array.isArray(patterns) ||
        patterns.some(
          (pattern) =>
            typeof pattern !== 'string' ||
            !pattern.startsWith('/') ||
            /[?#\\]/.test(pattern),
        )
      )
        throw new Error(`Invalid discovery exclusion: ${surface}`);
    }
    this.configuration = configuration;
  }

  includes(surface, route) {
    const normalized = route.replace(/\/$/, '') || '/';
    return !(this.configuration[surface] ?? []).some((pattern) => {
      const segments = pattern.split('/').slice(1);
      const expression = segments
        .map((segment, index) => {
          if (segment === '**')
            return index === segments.length - 1 ? '(?:/.*)?' : '(?:/[^/]+)*';
          if (segment === '*') return '/[^/]+';
          return `/${segment
            .split('*')
            .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*')}`;
        })
        .join('');
      return new RegExp(`^${expression}$`).test(normalized);
    });
  }
}

export const createDiscoveryPolicy = (configuration) =>
  new DiscoveryPolicy(configuration);
