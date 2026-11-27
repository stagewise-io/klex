/** How the confirmation text names this machine. */
export function thisComputer(): string {
  const agent = navigator.userAgent;
  if (agent.includes('Windows')) return 'this PC';
  if (agent.includes('Macintosh')) return 'this Mac';
  return 'this computer';
}
