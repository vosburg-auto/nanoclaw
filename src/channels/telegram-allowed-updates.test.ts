/**
 * Fork patch (vosburg-auto): pins the Telegram long-polling update set.
 *
 * Before this file, `allowedUpdates` occurred exactly once in the tree and in no
 * test or fixture. Dropping `message_reaction` stops reaction ingestion and
 * dropping `callback_query` stops inline-keyboard clicks — the transport the
 * OneCLI approval cards ride on — with nothing going red: approvals just stop
 * being answerable. By our own account this hunk recurs at every upstream sync,
 * so it gets a guard in a fork-owned filename.
 *
 * Scope, stated honestly: the second case mocks `@chat-adapter/telegram` and
 * invokes the registered factory, so it observes the config the adapter is
 * ACTUALLY constructed with — not merely the constant's value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const created: Array<Record<string, unknown>> = [];

vi.mock('@chat-adapter/telegram', () => ({
  createTelegramAdapter: (config: Record<string, unknown>) => {
    created.push(config);
    return { name: 'telegram', start: vi.fn(), stop: vi.fn(), send: vi.fn(), on: vi.fn() };
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'test-token' }),
}));

vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: () => ({
    channelType: 'telegram',
    setup: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  }),
}));

beforeEach(() => {
  created.length = 0;
  // telegram.ts kicks off a live getMe on construction and its setup awaits the
  // result. Stub it so the boot path completes offline.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telegram allowedUpdates', () => {
  it('subscribes to exactly the four update types the fork depends on', async () => {
    const { TELEGRAM_ALLOWED_UPDATES } = await import('./telegram.js');
    expect([...TELEGRAM_ALLOWED_UPDATES].sort()).toEqual([
      'callback_query',
      'edited_message',
      'message',
      'message_reaction',
    ]);
  });

  it('passes that set through to the adapter constructed at boot', async () => {
    // Import telegram.ts directly (not the barrel) so only this channel is
    // registered, then drive the real boot path. initChannelAdapters swallows
    // per-channel errors by design, but the factory records its config before
    // any setup runs, so the assertion below holds either way.
    await import('./telegram.js');
    const { initChannelAdapters } = await import('./channel-registry.js');
    await initChannelAdapters(() => ({}) as never);

    expect(created).toHaveLength(1);
    const longPolling = created[0].longPolling as { allowedUpdates: string[] };
    // callback_query is called out separately: losing it breaks OneCLI approvals.
    expect(longPolling.allowedUpdates).toContain('callback_query');
    expect(longPolling.allowedUpdates).toContain('message_reaction');
    expect([...longPolling.allowedUpdates].sort()).toEqual([
      'callback_query',
      'edited_message',
      'message',
      'message_reaction',
    ]);
  });
});
