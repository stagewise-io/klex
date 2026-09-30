import './styles.css';

import { IconDiscord } from '@stagewise/ui/src/icons/provider/IconDiscord.tsx';

import {
  type CardProps,
  FeatureCard,
  type SceneProps,
} from '../../shared/feature-card';
import { SceneBot } from '../../shared/scene-bot';
import { useBeat } from '../../shared/use-beat';

export function PermissionsCard({ playing }: CardProps) {
  return (
    <FeatureCard
      id="permissions"
      title="Set permissions for each Klex Bot"
      description="Manage each Klex Bot’s access directly in Slack, Discord, and your other apps, using their built-in permissions."
      Scene={PermissionsScene}
      playing={playing}
    />
  );
}

function PermissionsScene({ active }: SceneProps) {
  const beat = useBeat(active, 3200);
  const selectedBot = beat % 2;
  return (
    <div className="bento-permissions-scene" data-bot={selectedBot}>
      <div className="bento-permission-app">
        <IconDiscord />
        <span>Discord</span>
        <span>Permissions</span>
      </div>
      <div className="bento-permission-access">
        <table className="bento-permission-table">
          <thead>
            <tr>
              <th scope="col">Channel access</th>
              {(['monica', 'jeff'] as const).map((bot, i) => (
                <th key={bot} scope="col">
                  <SceneBot
                    active={active && selectedBot === i}
                    bot={bot}
                    beat={beat}
                    reaction="happy-nod"
                    size={32}
                  />
                  <span>{i === 0 ? 'Monica' : 'Jeff'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">#hiring</th>
              <td className="bento-allowed">✓</td>
              <td className="bento-locked">No access</td>
            </tr>
            <tr>
              <th scope="row">#engineering</th>
              <td className="bento-locked">No access</td>
              <td className="bento-allowed">✓</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
