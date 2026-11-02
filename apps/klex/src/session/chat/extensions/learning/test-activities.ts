import {
  createActivityFixture,
  TEST_ACTIVITY_LIMITS,
} from '@/activity-history/test-support';

/** Raw transcript fixtures; each day's retained messages form a runtime batch. */
export async function learningActivities() {
  const fixture = await createActivityFixture();
  const texts = [
    'Mara requested a rename of eventId in the published push-notification protocol. I changed the protocol and emitting server without checking its consumers. Jonas explained that all clients deduplicate on eventId: always ask before changing a core contract and propose the change first. I reverted the change, told the team why, and will wait for approval before editing published contracts. This is feedback about a general workflow, not a request to memorize the current task.',
    'A repository script failed because the machine defaulted to an older Node runtime. The output said Node.js 26 is required. I ran nvm use in the repository root, which read .nvmrc, and repeated the command successfully. Before running repository scripts on a disposable environment, use the repository-pinned runtime rather than assuming its machine default is supported. The initial error and successful retry identify the prerequisite; do not memorize machine-specific installation paths.',
    'The team discussed team lunch and selected a nearby restaurant. I checked availability and shared the result with the channel. Everyone confirmed the reservation and the conversation ended. This was a one-off coordination task with no reusable failure, behavioral feedback, or special prerequisite. Lunch details are transient context, not a durable skill. No skill should be created just because the activity contains enough text to be considered by the extraction worker.',
  ];
  const ids: string[] = [];
  for (const [index, text] of texts.entries()) {
    fixture.setTime(`2026-10-0${index + 1}T12:00:00Z`);
    ids.push((await fixture.append(text)).id);
  }
  fixture.setTime('2026-10-04T12:00:00Z');
  return { ...fixture, ids, texts, limits: TEST_ACTIVITY_LIMITS };
}
