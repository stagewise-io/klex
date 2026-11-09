import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';

import { i18n } from './i18n';
import { RichMessage } from './rich-message';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

it('keeps markup and translated placeholder order without rendering injected HTML', async () => {
  await i18n.changeLanguage('de');
  const markup = renderToStaticMarkup(
    <RichMessage
      message="{{author}} wants to merge 1 commit into {{base}} from {{branch}}"
      values={{
        author: <strong>Jonathan</strong>,
        base: <code>main</code>,
        branch: <code>{'<script>'}</code>,
      }}
    />,
  );
  expect(markup).toBe(
    '<strong>Jonathan</strong> möchte 1 Commit aus <code>&lt;script&gt;</code> in <code>main</code> mergen',
  );
});

it('keeps a styled mention in the complete sentence', () => {
  expect(
    renderToStaticMarkup(
      <RichMessage
        message="{{mention}}, the signup flow is ready to build."
        values={{ mention: <span className="mention">@Jonathan</span> }}
      />,
    ),
  ).toBe(
    '<span class="mention">@Jonathan</span>, the signup flow is ready to build.',
  );
});
