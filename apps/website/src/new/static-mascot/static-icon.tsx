import artwork from 'virtual:klex-static-mascots';

export function StaticIcon({ name }: { name: 'slack' | 'discord' | 'github' }) {
  return (
    <svg
      viewBox={
        name === 'discord'
          ? '0 0 256 199'
          : name === 'github'
            ? '0 0 32 32'
            : '0 0 32 32'
      }
      preserveAspectRatio="xMidYMid"
      aria-hidden="true"
    >
      <use href={`${artwork[name].src}#artwork`} />
    </svg>
  );
}
