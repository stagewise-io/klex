import { Fragment, type ReactNode } from 'react';

import { type Message, t } from './i18n';

/** Preserve full-sentence word order while rendering placeholder values as React nodes. */
export function RichMessage({
  message,
  values,
}: {
  message: Message;
  values: Record<string, ReactNode>;
}) {
  const names = Object.keys(values);
  const translated = t(
    message,
    Object.fromEntries(
      names.map((name, index) => [name, `\uE000${index}\uE001`]),
    ),
  );
  let offset = 0;
  const parts = translated.split(/(\uE000\d+\uE001)/).map((part) => {
    const key = `${translated}:${offset}:${part}`;
    offset += part.length;
    return { key, part };
  });
  return (
    <>
      {parts.map(({ key, part }) => (
        <Fragment key={key}>
          {/^\uE000\d+\uE001$/.test(part)
            ? values[names[Number(part.slice(1, -1))]]
            : part}
        </Fragment>
      ))}
    </>
  );
}
