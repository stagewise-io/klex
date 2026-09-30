import { createRoot } from 'react-dom/client';

import { LinearIssueDialog } from './dialog';

const host = document.getElementById('linear-issue-preview');
if (host) {
  createRoot(host).render(<LinearIssueDialog />);
}
