import artwork from 'virtual:klex-static-mascots';

export function StaticMascot({ name, size }: { name: string; size: number }) {
  const asset = artwork[name];
  if (!asset) throw new Error(`Unknown static mascot: ${name}`);
  return (
    <span
      style={{ display: 'block', width: size, height: size, flexShrink: 0 }}
    >
      <img
        src={asset.src}
        alt="Klex"
        width={size}
        height={size}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          overflow: 'visible',
        }}
      />
    </span>
  );
}
