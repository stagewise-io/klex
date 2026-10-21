import './features.css';

import { Fragment } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { usePlayback } from '../../playback';
import { AutonomyCard } from './cards/autonomy';
import { CollaborationCard } from './cards/collaboration';
import { HostingCard } from './cards/hosting';
import { IdentityCard } from './cards/identity';
import { MemoryCard } from './cards/memory';
import { PermissionsCard } from './cards/permissions';
import { ProductCard } from './cards/product';
import { ToolsCard } from './cards/tools';

export function FeatureBento() {
  const { host, active: playing, reducedMotion } = usePlayback(0);

  return (
    // Recreate avatar rigs when the OS motion preference changes.
    <div ref={host} className="bento-grid">
      <Fragment key={reducedMotion ? 'still' : 'animated'}>
        <ProductCard playing={playing} />
        <ToolsCard playing={playing} />
        <IdentityCard playing={playing} />
        <CollaborationCard playing={playing} />
        <PermissionsCard playing={playing} />
        <AutonomyCard playing={playing} />
        <MemoryCard playing={playing} />
        <HostingCard playing={playing} />
      </Fragment>
    </div>
  );
}

export function mountFeatures() {
  const container = document.querySelector<HTMLElement>('.new-features-mount');
  if (!container) throw new Error('The feature section is missing.');
  const root = container.hasChildNodes()
    ? hydrateRoot(container, <FeatureBento />, {
        identifierPrefix: 'features-',
      })
    : createRoot(container, { identifierPrefix: 'features-' });
  if (!container.hasChildNodes()) root.render(<FeatureBento />);
  return () => root.unmount();
}
