import './features.css';

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AutonomyCard } from './cards/autonomy';
import { CollaborationCard } from './cards/collaboration';
import { HostingCard } from './cards/hosting';
import { IdentityCard } from './cards/identity';
import { MemoryCard } from './cards/memory';
import { PermissionsCard } from './cards/permissions';
import { ProductCard } from './cards/product';
import { ToolsCard } from './cards/tools';

function FeatureBento() {
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const playing = !reducedMotion && pageVisible;

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReducedMotion(preference.matches);
    document.addEventListener('visibilitychange', onVisibility);
    preference.addEventListener('change', onMotion);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      preference.removeEventListener('change', onMotion);
    };
  }, []);

  return (
    // Recreate avatar rigs when the OS motion preference changes.
    <div key={reducedMotion ? 'still' : 'animated'} className="bento-grid">
      <ProductCard playing={playing} />
      <ToolsCard playing={playing} />
      <IdentityCard playing={playing} />
      <CollaborationCard playing={playing} />
      <PermissionsCard playing={playing} />
      <AutonomyCard playing={playing} />
      <MemoryCard playing={playing} />
      <HostingCard playing={playing} />
    </div>
  );
}

export function mountFeatures() {
  const container = document.querySelector<HTMLElement>('.new-features-mount');
  if (!container) throw new Error('The feature section is missing.');
  const root = createRoot(container);
  root.render(<FeatureBento />);
  return () => root.unmount();
}
