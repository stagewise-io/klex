import { useState } from 'react';

import { Button } from '../components/ui/button.tsx';
import { desktop } from '../lib/desktop.ts';

export function UpdateBanner({ version }: { version: string }) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      // Resolves only if the install fails; on success the app restarts.
      await desktop.installUpdate();
    } catch (installError) {
      setError(String(installError));
      setInstalling(false);
    }
  };

  return (
    <div className="mb-3 flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-4">
        <span>Klex Desktop {version} is ready</span>
        <Button size="sm" disabled={installing} onClick={() => void install()}>
          {installing ? 'Restarting…' : 'Restart to update'}
        </Button>
      </div>
      {error ? (
        <p className="select-text text-destructive text-xs">{error}</p>
      ) : null}
    </div>
  );
}
