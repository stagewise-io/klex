import { useState } from 'react';

import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Separator } from '../components/ui/separator.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { type DesktopStatus, desktop } from '../lib/desktop.ts';

const STATE_TEXT: Record<
  DesktopStatus['state'],
  {
    label: string;
    variant: 'default' | 'secondary' | 'warning' | 'destructive';
  }
> = {
  connected: { label: 'Connected', variant: 'default' },
  connecting: { label: 'Connecting', variant: 'secondary' },
  offline: { label: 'Offline', variant: 'warning' },
  error: { label: 'Needs attention', variant: 'destructive' },
  stopped: { label: 'Disconnected', variant: 'secondary' },
};

function headline(status: DesktopStatus): string {
  const organization = status.organizationName ?? 'Klex Cloud';
  switch (status.state) {
    case 'connected':
      return `Connected to ${organization}`;
    case 'connecting':
      return `Connecting to ${organization}…`;
    case 'offline':
      return 'Offline. Reconnecting automatically…';
    case 'error':
      return 'Klex Cloud refused this computer';
    case 'stopped':
      return 'Disconnected. Bots can’t reach this computer.';
  }
}

export function StatusView({
  status,
  onStatus,
}: {
  status: DesktopStatus;
  onStatus: (status: DesktopStatus) => void;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const state = STATE_TEXT[status.state];

  const run = async (action: () => Promise<DesktopStatus>) => {
    setBusy(true);
    setActionError(null);
    try {
      onStatus(await action());
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-col gap-2">
        <Badge variant={state.variant}>{state.label}</Badge>
        <h2 className="font-medium text-lg leading-snug">{headline(status)}</h2>
        {status.reason ? (
          <p className="select-text text-muted-foreground text-sm">
            {status.reason}
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {status.organizationName ? (
          <>
            <dt className="text-muted-foreground">Organization</dt>
            <dd>{status.organizationName}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Machine ID</dt>
        <dd className="select-text truncate font-mono text-xs leading-5">
          {status.machineId ?? '—'}
        </dd>
      </dl>

      <Separator />

      <div className="flex items-center justify-between gap-4 text-sm">
        <span id="autostart-label">
          Start when I sign in
          <span className="block text-muted-foreground text-xs">
            Keeps this computer connected after a restart.
          </span>
        </span>
        <Switch
          aria-labelledby="autostart-label"
          checked={status.autostart}
          disabled={busy}
          onCheckedChange={(checked) =>
            void run(() => desktop.setAutostart(checked))
          }
        />
      </div>

      <Separator />

      <div className="flex flex-wrap gap-2">
        {status.enabled ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => desktop.setEnabled(false))}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => void run(() => desktop.setEnabled(true))}
          >
            Connect
          </Button>
        )}
        {confirmForget ? (
          <>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void run(() => desktop.forget())}
            >
              Forget this computer
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmForget(false)}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmForget(true)}
          >
            Forget…
          </Button>
        )}
      </div>
      {confirmForget ? (
        <p className="text-muted-foreground text-xs">
          Forgetting deletes this computer’s identity here. Also delete the
          machine in Klex Cloud. To connect again you need a new code.
        </p>
      ) : null}
      {actionError ? (
        <p className="select-text text-destructive text-sm">{actionError}</p>
      ) : null}
    </div>
  );
}
