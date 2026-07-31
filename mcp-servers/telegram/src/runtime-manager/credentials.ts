export interface TelegramCredentials {
  botToken: string;
  allowedUserIds: ReadonlySet<string>;
}

export class TelegramCredentialError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TelegramCredentialError';
    this.status = status;
  }
}

const MAX_TOKEN_LENGTH = 256;
const MAX_ALLOWED_USERS = 100;

export function parseTelegramCredentials(
  request: Request,
): TelegramCredentials {
  const authorization = request.headers.get('authorization');
  const explicitToken = request.headers.get('x-telegram-bot-token');
  let authorizationToken: string | undefined;
  if (authorization) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) {
      throw new TelegramCredentialError('Invalid Authorization header', 401);
    }
    authorizationToken = match[1];
  }
  if (
    authorizationToken &&
    explicitToken &&
    authorizationToken !== explicitToken
  ) {
    throw new TelegramCredentialError('Conflicting Telegram credentials', 401);
  }
  const botToken = authorizationToken ?? explicitToken;
  if (
    !botToken ||
    botToken.length > MAX_TOKEN_LENGTH ||
    /\s/.test(botToken) ||
    containsControlCharacter(botToken)
  ) {
    throw new TelegramCredentialError(
      'Missing or invalid Telegram bot token',
      401,
    );
  }

  const allowedHeader = request.headers.get('x-telegram-allowed-user-ids');
  if (!allowedHeader) {
    throw new TelegramCredentialError(
      'Missing Telegram allowed user IDs header',
    );
  }
  const values = allowedHeader.split(',').map((value) => value.trim());
  if (
    values.length > MAX_ALLOWED_USERS ||
    values.some((value) => !/^[1-9]\d*$/.test(value))
  ) {
    throw new TelegramCredentialError('Invalid Telegram allowed user IDs');
  }
  return { botToken, allowedUserIds: new Set(values) };
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
