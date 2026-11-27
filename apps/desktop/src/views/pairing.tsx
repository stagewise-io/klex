import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { formatCode, isCompleteCode } from '../lib/code.ts';
import {
  type DesktopStatus,
  desktop,
  type EnrollmentPreview,
  isPairingError,
  onPairCode,
  type PairingError,
  subscribe,
} from '../lib/desktop.ts';
import { thisComputer } from '../lib/platform.ts';

type Step =
  | { name: 'enter' }
  | { name: 'checking' }
  | { name: 'confirm'; preview: EnrollmentPreview }
  | { name: 'connecting'; preview: EnrollmentPreview };

/** Cloud's enrollment rate limit refills one attempt per minute. */
const RATE_LIMIT_MS = 60_000;

function toPairingError(error: unknown): PairingError {
  if (isPairingError(error)) return error;
  return { kind: 'failed', message: String(error) };
}

function errorText(error: PairingError): { title: string; detail: string } {
  switch (error.kind) {
    case 'invalidCode':
      return {
        title: 'Code invalid or expired',
        detail:
          'Codes work once and expire after 15 minutes. Create a new code in Klex Cloud and enter it here.',
      };
    case 'rateLimited':
      return {
        title: 'Too many attempts',
        detail: 'Try again in a minute.',
      };
    case 'unreachable':
      return {
        title: 'Can’t reach Klex Cloud',
        detail: 'Check your internet connection, then try again.',
      };
    case 'alreadyPaired':
      return {
        title: 'Already connected',
        detail: 'This computer is already connected to Klex Cloud.',
      };
    case 'noPendingCode':
      return {
        title: 'Enter the code again',
        detail: 'The code was cleared. Enter it again to continue.',
      };
    case 'failed':
      return { title: 'Something went wrong', detail: error.message };
  }
}

export function Pairing({
  onPaired,
}: {
  onPaired: (status: DesktopStatus) => void;
}) {
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ name: 'enter' });
  const [error, setError] = useState<PairingError | null>(null);
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);
  const blockedUntilRef = useRef(0);
  blockedUntilRef.current = blockedUntil;
  const stepRef = useRef(step);
  stepRef.current = step;

  const blocked = blockedUntil > now;
  useEffect(() => {
    if (!blocked) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [blocked]);

  const fail = useCallback((value: unknown) => {
    const pairingError = toPairingError(value);
    if (pairingError.kind === 'rateLimited') {
      setBlockedUntil(Date.now() + RATE_LIMIT_MS);
      setNow(Date.now());
    }
    setError(pairingError);
    setStep({ name: 'enter' });
  }, []);

  const preview = useCallback(
    async (value: string) => {
      if (busy.current || !isCompleteCode(value)) return;
      busy.current = true;
      setError(null);
      setStep({ name: 'checking' });
      try {
        const result = await desktop.previewCode(value);
        setStep({ name: 'confirm', preview: result });
      } catch (value) {
        fail(value);
      } finally {
        busy.current = false;
      }
    },
    [fail],
  );

  // A deep link fills in the code and checks it once. Nothing retries after
  // a failure, because previews share Cloud's enrollment rate limit. Links
  // that arrive while a code awaits consent or is connecting are ignored, so
  // they cannot swap the code the person is agreeing to.
  useEffect(() => {
    const accept = (raw: string) => {
      const current = stepRef.current.name;
      if (current === 'confirm' || current === 'connecting') return;
      const formatted = formatCode(raw);
      setCode(formatted);
      if (Date.now() >= blockedUntilRef.current) void preview(formatted);
    };
    const unsubscribe = subscribe(onPairCode(accept));
    void desktop.takePendingPairCode().then((pending) => {
      if (pending) accept(pending);
    });
    return unsubscribe;
  }, [preview]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked) void preview(code);
  };

  const cancel = () => {
    void desktop.cancelPairing();
    setStep({ name: 'enter' });
  };

  const connect = async (result: EnrollmentPreview) => {
    setStep({ name: 'connecting', preview: result });
    try {
      onPaired(await desktop.confirmPairing());
    } catch (value) {
      fail(value);
    }
  };

  if (step.name === 'confirm' || step.name === 'connecting') {
    const connecting = step.name === 'connecting';
    return (
      <div className="flex flex-col gap-5 pt-2">
        <div className="flex flex-col gap-3">
          <h2 className="font-medium text-lg leading-snug">
            Connect {thisComputer()} to{' '}
            <strong className="font-semibold">
              {step.preview.organizationName}
            </strong>{' '}
            as{' '}
            <strong className="font-semibold">
              {step.preview.machineName}
            </strong>
            ?
          </h2>
          <p className="text-muted-foreground text-sm">
            Bots assigned in Klex Cloud will be able to see the screen and use
            mouse and keyboard.
          </p>
          <p className="text-muted-foreground text-xs">
            Only continue if you created this code yourself or got it from
            someone you trust in this organization.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="lg"
            onClick={() => void connect(step.preview)}
            disabled={connecting}
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={cancel}
            disabled={connecting}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const checking = step.name === 'checking';
  const seconds = Math.ceil((blockedUntil - now) / 1000);
  const shown = error ? errorText(error) : null;
  return (
    <form className="flex flex-col gap-4 pt-2" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <h2 className="font-medium text-lg">Connect {thisComputer()}</h2>
        <p className="text-muted-foreground text-sm">
          In Klex Cloud, open Machines, choose New computer, then Your own
          computer. Enter the code it shows.
        </p>
      </div>
      <Input
        aria-label="Enrollment code"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="XXXX-XXXX-XXXX"
        className="h-11 text-center font-mono text-lg tracking-widest"
        value={code}
        onChange={(event) => {
          setCode(formatCode(event.target.value));
          if (error?.kind !== 'rateLimited') setError(null);
        }}
        disabled={checking}
      />
      {shown ? (
        <Alert variant={error?.kind === 'failed' ? 'destructive' : 'default'}>
          <AlertTitle>{shown.title}</AlertTitle>
          <AlertDescription>
            {error?.kind === 'rateLimited' && blocked
              ? `Try again in ${seconds} s.`
              : shown.detail}
          </AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="submit"
        size="lg"
        disabled={!isCompleteCode(code) || checking || blocked}
      >
        {checking ? 'Checking code…' : 'Continue'}
      </Button>
    </form>
  );
}
