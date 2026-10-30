import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';

/** Apply defaults at the transport boundary, for both generation and streaming. */
export function withPromptCaching(
  model: LanguageModelV4,
  namespace: 'gateway' | 'anthropic' | 'openrouter',
  aliases: string[] = [],
): LanguageModelV4 {
  const namespaces = [namespace, ...aliases];
  const keys =
    namespace === 'gateway' ? ['caching'] : ['cacheControl', 'cache_control'];
  const hasCaching = (options: LanguageModelV4CallOptions['providerOptions']) =>
    namespaces.some((name) =>
      keys.some((key) => options?.[name] && key in options[name]),
    );
  // Gateway v4 forwards provider options but no longer derives this header.
  const withGatewayHeader = (
    params: LanguageModelV4CallOptions,
  ): LanguageModelV4CallOptions =>
    namespace === 'gateway' &&
    params.providerOptions?.gateway?.caching === 'auto'
      ? {
          ...params,
          headers: { 'x-vercel-ai-gateway-caching': 'auto', ...params.headers },
        }
      : params;

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        if (hasCaching(params.providerOptions)) {
          // Null and undefined are explicit opt-outs; never pass null to SDK validators.
          const providerOptions = { ...params.providerOptions };
          let changed = false;
          for (const name of namespaces) {
            const options = providerOptions[name];
            if (!options) continue;
            for (const key of keys) {
              if (key in options && options[key] == null) {
                providerOptions[name] = { ...providerOptions[name] };
                delete providerOptions[name][key];
                changed = true;
              }
            }
          }
          return withGatewayHeader(
            changed ? { ...params, providerOptions } : params,
          );
        }
        if (
          namespace !== 'gateway' &&
          params.prompt.some(
            (message) =>
              hasCaching(message.providerOptions) ||
              (Array.isArray(message.content) &&
                message.content.some((part) =>
                  hasCaching(part.providerOptions),
                )),
          )
        )
          return params;

        const key =
          namespace === 'gateway'
            ? 'caching'
            : namespace === 'anthropic'
              ? 'cacheControl'
              : 'cache_control';
        return withGatewayHeader({
          ...params,
          providerOptions: {
            ...params.providerOptions,
            [namespace]: {
              ...params.providerOptions?.[namespace],
              [key]: namespace === 'gateway' ? 'auto' : { type: 'ephemeral' },
            },
          },
        });
      },
    },
  });
}
