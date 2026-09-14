export interface PublicError {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

export function errorContent(operation: string, error: unknown): PublicError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      { type: 'text', text: JSON.stringify({ operation, error: message }) },
    ],
    isError: true,
  };
}
