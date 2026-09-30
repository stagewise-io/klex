import './guides-faq.css';

import { createRoot } from 'react-dom/client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@stagewise/ui/src/components/ui/accordion.tsx';
import { IconPlusOutline18 } from '@stagewise/ui/src/icons/nucleo/ui-outline-18/IconPlusOutline18.tsx';

export const guidesFaqMarkup = `
  <section class="new-guides-faq" id="guides-faq" aria-label="Guides and FAQs">
    <div class="new-guides-faq-mount"></div>
  </section>
`;

const guides = [
  { title: 'Create a company-handbook', slug: 'company-handbook' },
  {
    title: 'Create distinct identities and permissions for every bot',
    slug: 'bot-identities',
  },
  { title: 'Use shared messaging boards', slug: 'shared-messaging-boards' },
];

const questions = [
  {
    question: 'What can Klex Bots do?',
    answer:
      'By connecting the tools your company uses, Klex Bots perform tasks and deliver work in those tools.',
  },
  {
    question: 'How can I connect the apps my company uses?',
    answer:
      "The Klex Cloud lets you create and connect a new identity for every new Klex Bot per app. That way, a Klex Bot called Jonathan will become @jonathan on your team's Slack.",
  },
  {
    question: 'What can they see?',
    answer:
      'They can only see through connectors, so they will only see what you connect and give permissions to.',
  },
  {
    question: 'Can they handle recurring tasks?',
    answer:
      'Ask them to set up a schedule and they will repeatedly start working on the specified task.',
  },
  {
    question: "Will they work while I'm away?",
    answer:
      "That's the whole point. Klex Bots will work while you sleep, attend a conference or hold a meetup.",
  },
  {
    question: 'Can I use more than one Klex Bot?',
    answer:
      'You should use more than one Klex Bot. Every Bot should get a distinct identity and a narrow job. The Bots will collaborate as a team.',
  },
];

function GuidesFaq() {
  return (
    <>
      <nav className="guides-intro" id="guides" aria-labelledby="guides-title">
        <h2 id="guides-title">
          Best practices for building a Bot-native team.
        </h2>
        <ul className="guides-links">
          {guides.map(({ title, slug }) => (
            <li key={slug}>
              <a href={`https://docs.klex.bot/guides/${slug}`}>
                <span>{title}</span>
                <span aria-hidden="true">→</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <section className="guides-faq" id="faq" aria-labelledby="faq-title">
        <h2 id="faq-title">FAQs</h2>
        <Accordion defaultValue={[questions[0].question]}>
          {questions.map(({ question, answer }) => (
            <AccordionItem
              key={question}
              value={question}
              className="guides-faq-item"
            >
              <AccordionTrigger className="guides-faq-trigger">
                <span>{question}</span>
                <span className="guides-faq-icon" aria-hidden="true">
                  <IconPlusOutline18 size={24} />
                </span>
              </AccordionTrigger>
              <AccordionContent className="guides-faq-answer">
                <p>{answer}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
    </>
  );
}

export function mountGuidesFaq() {
  const host = document.querySelector('.new-guides-faq-mount');
  if (!host) throw new Error('The guides and FAQ section is missing.');
  const root = createRoot(host);
  root.render(<GuidesFaq />);
  return () => root.unmount();
}
