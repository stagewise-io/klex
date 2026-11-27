import { useEffect, useState } from 'react';

import { KlexLogo } from './components/ui/klex-logo.tsx';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './components/ui/tabs.tsx';
import {
  type DesktopStatus,
  desktop,
  onStatus,
  subscribe,
} from './lib/desktop.ts';
import { LogsView } from './views/logs-view.tsx';
import { Pairing } from './views/pairing.tsx';
import { StatusView } from './views/status-view.tsx';
import { UpdateBanner } from './views/update-banner.tsx';

export function App() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribe(onStatus(setStatus));
    desktop
      .status()
      .then(setStatus)
      .catch((error: unknown) => setLoadError(String(error)));
    return unsubscribe;
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <KlexLogo size={28} />
        <h1 className="font-medium text-base">Klex Desktop</h1>
      </header>
      <main className="flex min-h-0 flex-1 flex-col px-5 pb-5">
        {status === null ? (
          <p className="text-muted-foreground text-sm">
            {loadError ?? 'Loading…'}
          </p>
        ) : (
          <>
            {status.updateVersion ? (
              <UpdateBanner version={status.updateVersion} />
            ) : null}
            <Tabs defaultValue="status" className="min-h-0 flex-1">
              <TabsList>
                <TabsTrigger value="status">
                  {status.paired ? 'Status' : 'Connect'}
                </TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
              </TabsList>
              <TabsContent
                value="status"
                keepMounted
                className="min-h-0 flex-1"
              >
                {status.paired ? (
                  <StatusView status={status} onStatus={setStatus} />
                ) : (
                  <Pairing onPaired={setStatus} />
                )}
              </TabsContent>
              <TabsContent
                value="logs"
                className="flex min-h-0 flex-1 flex-col"
              >
                <LogsView />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
    </div>
  );
}
