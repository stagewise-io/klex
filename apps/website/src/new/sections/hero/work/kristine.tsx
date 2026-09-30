import { useState } from 'react';

import { typeIssueText } from '../../linear';
import { LinearIssueDialog } from '../../linear/dialog';
import { usePlay, wait } from '../../workflow/stage';
import type { WorkSceneProps } from './scenes';

const issues = [
  {
    title: 'Add dark mode to the dashboard',
    description:
      'Customers keep asking for it. Follow the system setting and remember each user’s choice.',
    assignee: 'Jonathan',
    id: 'PRO-58',
  },
  {
    title: 'Onboarding checklist for new accounts',
    description:
      'Show three setup steps after signup. Hide the list once every step is done.',
    assignee: 'Jonathan',
    id: 'PRO-63',
  },
  {
    title: 'Plan Q4 hiring with each team',
    description:
      'Collect open roles from every team lead and agree on start dates by Friday.',
    assignee: 'Monica',
    id: 'PRO-66',
  },
];

export const kristineScene = {
  count: issues.length,
  app: () => ({ name: 'Linear', icon: 'linear' }),
  Scene: KristineScene,
};

function KristineScene({ variant, onDone }: WorkSceneProps) {
  const issue = issues[variant];
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState<string>();
  const [createdAs, setCreatedAs] = useState<string>();

  usePlay(
    true,
    async (signal) => {
      await wait(600, signal);
      await typeIssueText(issue.title, setTitle, signal, 700);
      await wait(300, signal);
      await typeIssueText(issue.description, setDescription, signal, 1500);
      await wait(500, signal);
      setAssignee(issue.assignee);
      await wait(700, signal);
      setCreatedAs(issue.id);
      await wait(1800, signal);
    },
    onDone,
  );

  return (
    <div className="new-work-linear">
      <LinearIssueDialog
        title={title}
        description={description}
        assignee={assignee}
        createdAs={createdAs}
      />
    </div>
  );
}
