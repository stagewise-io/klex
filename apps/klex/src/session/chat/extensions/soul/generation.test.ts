import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateText, type Tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSoulGenerationSystemPrompt } from './generation-system-prompt';
import {
  createSoul,
  createSoulExt,
  createSoulExtGod,
  type SoulDependencies,
} from './soul';

vi.mock('ai', async (original) => ({
  ...(await original<typeof import('ai')>()),
  generateText: vi.fn(),
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const generate = vi.mocked(generateText);
const directories: string[] = [];
const entries = [
  { providerId: 'provider-one', modelId: 'chat-one' },
  { providerId: 'provider-two', modelId: 'chat-two' },
];

function output(text = 'Direct, not rude.', finishReason = 'stop') {
  return { text, finishReason } as Awaited<ReturnType<typeof generateText>>;
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'soul-api-test-'));
  directories.push(directory);
  const soulDirectory = join(directory, 'soul');
  const logger = { warn: vi.fn() };
  const config = { getModelSelection: vi.fn(() => entries) };
  const modelResolver = {
    getLanguageModel: vi.fn((entry) => ({ modelId: entry.modelId })),
    resolveModel: vi.fn(() => ({
      providerOptions: { test: { reasoning: 'low' } },
    })),
  };
  const soul = createSoul({
    soulDirectory,
    logging: { child: () => logger } as unknown as SoulDependencies['logging'],
    config: config as unknown as SoulDependencies['config'],
    modelResolver:
      modelResolver as unknown as SoulDependencies['modelResolver'],
  });
  return { soul, directory, soulDirectory, config, modelResolver };
}

beforeEach(() => {
  generate.mockReset();
  generate.mockResolvedValue(output());
});
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Soul admin generation', () => {
  it('GET returns null without creating files, POST creates cleanly with the chat model and no tools', async () => {
    const { soul, soulDirectory, config, modelResolver } = setup();
    expect(soul.get()).toBeNull();
    expect(existsSync(soulDirectory)).toBe(false);
    expect(await soul.create('Be precise')).toBe('Direct, not rude.');
    expect(soul.get()).toBe('Direct, not rude.');
    expect(config.getModelSelection).toHaveBeenCalledWith('chat');
    expect(modelResolver.getLanguageModel).toHaveBeenCalledWith(entries[0]);
    const args = generate.mock.calls[0]![0];
    expect(JSON.parse(args.prompt as string)).toEqual({
      operation: 'create',
      user_request: 'Be precise',
    });
    expect(args).not.toHaveProperty('tools');
    expect(args).toMatchObject({
      maxRetries: 0,
      providerOptions: { test: { reasoning: 'low' } },
    });
    expect(args.system).toBe(getSoulGenerationSystemPrompt('create'));
    expect(readdirSync(soulDirectory)).toEqual(['SOUL.md']);
  });

  it('PATCH includes the full existing soul and instructions, then replaces it', async () => {
    const { soul } = setup();
    await soul.create('First');
    generate.mockResolvedValueOnce(output('Calm, not passive.'));
    expect(await soul.update('Become calmer')).toBe('Calm, not passive.');
    expect(JSON.parse(generate.mock.calls[1]![0].prompt as string)).toEqual({
      operation: 'update',
      existing_soul_description: 'Direct, not rude.',
      user_request: 'Become calmer',
    });
    expect(generate.mock.calls[1]![0].system).toBe(
      getSoulGenerationSystemPrompt('update'),
    );
    expect(soul.get()).toBe('Calm, not passive.');
  });

  it('POST re-creates an existing soul from scratch without exposing it to the model', async () => {
    const { soul } = setup();
    await soul.create('First');
    generate.mockClear();
    generate.mockResolvedValueOnce(output('New identity'));
    expect(await soul.create('Start over')).toBe('New identity');
    expect(JSON.parse(generate.mock.calls[0]?.[0].prompt as string)).toEqual({
      operation: 'create',
      user_request: 'Start over',
    });
    expect(generate.mock.calls[0]![0].system).toBe(
      getSoulGenerationSystemPrompt('create'),
    );
    expect(soul.get()).toBe('New identity');
  });

  it('keeps the existing soul during re-creation and preserves it if all attempts fail', async () => {
    const { soul } = setup();
    await soul.create('First');
    generate.mockRejectedValue(new Error('Invalid model'));
    const request = soul.create('Start over');
    expect(soul.get()).toBe('Direct, not rude.');
    await expect(request).rejects.toMatchObject({ code: 'generation_failed' });
    expect(soul.get()).toBe('Direct, not rude.');
  });

  it('does not overwrite a legacy cloud tool write during API generation', async () => {
    const { soul, soulDirectory } = setup();
    await soul.create('First');
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof generateText>>>();
    generate.mockReturnValueOnce(pending.promise);
    const request = soul.create('Start over');
    const god = createSoulExtGod.create({
      getDataDir: () => soulDirectory,
    } as Parameters<typeof createSoulExtGod.create>[0]);
    const update = god.getTools?.({} as never).updateSoul as
      | Tool<{ content: string }, string>
      | undefined;
    const execute = update?.execute;
    if (!execute) throw new Error('Missing legacy soul tool');
    await execute(
      { content: 'Cloud-written soul' },
      { toolCallId: 'legacy', messages: [], context: undefined },
    );
    pending.resolve(output('Generated replacement'));
    await expect(request).rejects.toMatchObject({ code: 'soul_changed' });
    expect(soul.get()).toBe('Cloud-written soul');
  });

  it.each(['', '  \n  '])(
    'optimizes the existing soul with blank instructions (%j)',
    async (instructions) => {
      const { soul } = setup();
      await soul.create('First');
      generate.mockClear();
      generate.mockResolvedValueOnce(output('Optimized identity'));
      expect(await soul.update(instructions)).toBe('Optimized identity');
      const args = generate.mock.calls[0]![0];
      expect(args.system).toBe(getSoulGenerationSystemPrompt('optimize'));
      expect(JSON.parse(args.prompt as string)).toEqual({
        operation: 'optimize',
        existing_soul_description: 'Direct, not rude.',
        user_request: '',
      });
      expect(soul.get()).toBe('Optimized identity');
    },
  );

  it('preserves the existing soul when optimization fails', async () => {
    const { soul } = setup();
    await soul.create('First');
    generate.mockRejectedValue(new Error('Failed'));
    await expect(soul.update('')).rejects.toMatchObject({
      code: 'generation_failed',
    });
    expect(soul.get()).toBe('Direct, not rude.');
  });

  it.each(['Change', ''])(
    'requires an existing soul for PATCH before spending model calls (%j)',
    async (instructions) => {
      const { soul } = setup();
      await expect(soul.update(instructions)).rejects.toMatchObject({
        code: 'soul_not_found',
      });
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it.each(['', '  ', 'x'.repeat(10_001)])(
    'rejects invalid instructions before generation (%#. case)',
    async (instructions) => {
      const { soul } = setup();
      await expect(soul.create(instructions)).rejects.toMatchObject({
        code: 'invalid_instructions',
      });
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it('fails immediately without configured chat models', async () => {
    const { soul, config } = setup();
    config.getModelSelection.mockReturnValue([]);
    await expect(soul.create('Create')).rejects.toMatchObject({
      code: 'no_chat_models',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('retries in chat model order with exactly three total attempts, including resolution failures', async () => {
    const { soul, modelResolver } = setup();
    modelResolver.getLanguageModel.mockImplementationOnce(() => {
      throw new Error('Bad provider');
    });
    generate.mockRejectedValueOnce(new Error('Bad model'));
    expect(await soul.create('Create')).toBe('Direct, not rude.');
    expect(
      modelResolver.getLanguageModel.mock.calls.map(([entry]) => entry),
    ).toEqual([entries[0], entries[1], entries[0]]);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries without creating a soul and allows a later corrected-model request', async () => {
    const { soul, soulDirectory } = setup();
    generate.mockRejectedValue(new Error('Bad model'));
    await expect(soul.create('Create')).rejects.toMatchObject({
      code: 'generation_failed',
    });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(existsSync(soulDirectory)).toBe(false);
    generate.mockResolvedValue(output());
    await expect(soul.create('Retry')).resolves.toBe('Direct, not rude.');
  });

  it.each([
    ['', 'stop'],
    ['  ', 'stop'],
    ['<soul> </soul>', 'stop'],
    ['x'.repeat(10_001), 'stop'],
    ['Partial', 'length'],
    ['Refusal', 'content-filter'],
    ['Call', 'tool-calls'],
    ['```md\nSoul\n```', 'stop'],
  ])(
    'rejects incomplete/invalid output without changing the existing soul (%#. case)',
    async (text, reason) => {
      const { soul, soulDirectory } = setup();
      await soul.create('First');
      generate.mockClear();
      generate.mockResolvedValue(output(text, reason));
      await expect(soul.update('Change')).rejects.toMatchObject({
        code: 'generation_failed',
      });
      expect(generate).toHaveBeenCalledTimes(3);
      expect(readFileSync(join(soulDirectory, 'SOUL.md'), 'utf8')).toBe(
        'Direct, not rude.',
      );
      expect(readdirSync(soulDirectory)).toEqual(['SOUL.md']);
    },
  );

  it('accepts the 10,000-character boundary and strips nested soul tags', async () => {
    const { soul } = setup();
    generate.mockResolvedValue(output(`<soul>${'x'.repeat(10_000)}</soul>`));
    expect(await soul.create('Create')).toBe('x'.repeat(10_000));
  });

  it('rejects concurrent mutations while GET remains available', async () => {
    const { soul } = setup();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof generateText>>>();
    generate.mockReturnValueOnce(pending.promise);
    const first = soul.create('Create');
    await expect(soul.create('Duplicate')).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
    await expect(soul.update('Conflict')).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
    expect(soul.get()).toBeNull();
    pending.resolve(output());
    await first;
    expect(generate).toHaveBeenCalledOnce();
  });

  it('does not overwrite an external edit made while generation runs', async () => {
    const { soul, soulDirectory } = setup();
    await soul.create('First');
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof generateText>>>();
    generate.mockReturnValueOnce(pending.promise);
    const update = soul.update('Change');
    writeFileSync(join(soulDirectory, 'SOUL.md'), 'Manual edit');
    pending.resolve(output('Generated replacement'));
    await expect(update).rejects.toMatchObject({ code: 'soul_changed' });
    expect(soul.get()).toBe('Manual edit');
  });

  it('preserves the old document and cleans temporary files on a save failure', async () => {
    const { soul, soulDirectory } = setup();
    await soul.create('First');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('Rename failed');
    });
    await expect(soul.update('Change')).rejects.toThrow('Rename failed');
    expect(soul.get()).toBe('Direct, not rude.');
    expect(readdirSync(soulDirectory)).toEqual(['SOUL.md']);
  });

  it('bounds uncooperative model calls to 60 seconds each and never saves a late result', async () => {
    vi.useFakeTimers();
    const { soul } = setup();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof generateText>>>();
    generate.mockReturnValue(pending.promise);
    const request = expect(soul.create('Create')).rejects.toMatchObject({
      code: 'generation_failed',
    });
    await vi.advanceTimersByTimeAsync(180_000);
    await request;
    expect(generate).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      generate.mock.calls.every(([args]) => args.abortSignal?.aborted),
    ).toBe(true);
    pending.resolve(output('Too late'));
    await Promise.resolve();
    expect(soul.get()).toBeNull();
  });

  it('cancels without retries or committing a late result', async () => {
    const { soul } = setup();
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof generateText>>>();
    generate.mockReturnValueOnce(pending.promise);
    const abort = new AbortController();
    const request = soul.create('Create', abort.signal);
    abort.abort();
    await expect(request).rejects.toMatchObject({ code: 'request_cancelled' });
    pending.resolve(output('Too late'));
    await Promise.resolve();
    expect(soul.get()).toBeNull();
    expect(generate).toHaveBeenCalledOnce();
    await expect(
      soul.create('Already cancelled', abort.signal),
    ).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('unblocks existing regular extensions after API creation, retaining the legacy god tool', async () => {
    const { soul, soulDirectory } = setup();
    const deps = { getDataDir: () => soulDirectory } as Parameters<
      typeof createSoulExt.create
    >[0];
    const regular = createSoulExt.create(deps);
    const god = createSoulExtGod.create(deps);
    expect(regular.shouldRunStep!([])).toBe(false);
    expect(god.getTools?.({} as never)).toHaveProperty('updateSoul');
    await soul.create('Create');
    expect(regular.shouldRunStep!([])).toBe(true);
    expect(regular.getSystemPromptPart!()).toContain('Direct, not rude.');
    expect(god.getTools?.({} as never)).toHaveProperty('updateSoul');
  });
});
