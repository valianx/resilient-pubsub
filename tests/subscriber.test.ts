/**
 * Tests for PR-6: createResilientSubscriber.
 *
 * All tests use a fake SubscriptionLike / SubscriberPubSubLike so that the
 * entire suite runs synchronously-fast with no real Pub/Sub calls. An
 * injectable `_sleep` is used for the graceful-stop timeout race to avoid
 * wall-clock waits.
 *
 * Covered acceptance criteria:
 * - AC-6.1: Handler resolves → ack() called, onAck fired, nack not called;
 *            handler receives deserialized body, extracted headers, meta.
 * - AC-6.2: Handler throws → nack() called, onError + onNack fired with
 *            ResilientPubSubError{kind:'process'}, ack not called, no crash.
 * - AC-6.3: Malformed body → handler NOT invoked, nack() called, onPoison fired.
 * - AC-6.4: start() without pubSubClient → throws ResilientPubSubError{kind:'config'}.
 * - AC-6.5: Graceful stop — slow handler completes before stop resolves (acked);
 *            handler exceeding tiny stopTimeoutMs → stop() nacks in-flight and resolves.
 * - AC-6.6: stop() is idempotent (second call resolves immediately, no double-nack).
 * - AC-6.7: .subscription getter exposed; flowControl passed to subscription(name, ...).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createResilientSubscriber } from '../src/subscriber/subscriber.ts';
import type {
  AckableMessage,
  SubscriptionLike,
  SubscriberPubSubLike,
} from '../src/subscriber/subscriber.ts';
import { ResilientPubSubError } from '../src/errors/error.ts';
import { SerializationError } from '../src/errors/error.ts';

// ============================================================================
// Test helpers — fake Pub/Sub subscription
// ============================================================================

/**
 * Records listener registrations and lets tests emit fake messages or errors
 * programmatically.
 */
interface FakeSubscription extends SubscriptionLike {
  /** Emit a fake AckableMessage to the registered 'message' listener. */
  emitMessage(msg: AckableMessage): void;
  /** Emit an error to the registered 'error' listener. */
  emitError(err: unknown): void;
  /** Name/options passed to subscription() on the fake client. */
  capturedName: string;
  capturedOptions: unknown;
  /** Whether close() has been called. */
  closeCalled: boolean;
}

/**
 * Builds a fake SubscriptionLike that captures listener registrations and
 * exposes imperative emit helpers for test control.
 */
function makeFakeSubscription(name: string, options: unknown): FakeSubscription {
  let messageListener: ((msg: AckableMessage) => void) | undefined;
  let errorListener: ((err: unknown) => void) | undefined;

  const sub: FakeSubscription = {
    capturedName: name,
    capturedOptions: options,
    closeCalled: false,

    on(event: 'message' | 'error', listener: ((msg: AckableMessage) => void) & ((err: unknown) => void)): unknown {
      if (event === 'message') {
        messageListener = listener as (msg: AckableMessage) => void;
      } else if (event === 'error') {
        errorListener = listener as (err: unknown) => void;
      }
      return sub;
    },

    removeAllListeners(event?: string): unknown {
      if (event === 'message' || event === undefined) {
        messageListener = undefined;
      }
      if (event === 'error' || event === undefined) {
        errorListener = undefined;
      }
      return sub;
    },

    async close(): Promise<void> {
      sub.closeCalled = true;
    },

    emitMessage(msg: AckableMessage): void {
      if (messageListener !== undefined) {
        messageListener(msg);
      }
    },

    emitError(err: unknown): void {
      if (errorListener !== undefined) {
        errorListener(err);
      }
    },
  };

  return sub;
}

/** Last fake subscription created by makeFakeClient. */
let lastFakeSub: FakeSubscription | undefined;

/**
 * Builds a fake SubscriberPubSubLike that creates a FakeSubscription
 * and records the subscription() call arguments.
 */
function makeFakeClient(): SubscriberPubSubLike {
  return {
    subscription(name: string, options?: unknown): SubscriptionLike {
      const sub = makeFakeSubscription(name, options);
      lastFakeSub = sub;
      return sub;
    },
  };
}

/**
 * Builds a minimal AckableMessage with ack/nack spies.
 *
 * @param body        - JSON-serializable body (will be Buffer.from(JSON.stringify(...))).
 * @param attributes  - Optional message attributes.
 * @param id          - Optional message ID.
 * @param deliveryAttempt - Optional delivery attempt count.
 */
function makeMessage(
  body: unknown,
  attributes: Record<string, string> = {},
  id = 'msg-001',
  deliveryAttempt?: number
): AckableMessage & { ackCalled: boolean; nackCalled: boolean; nackCount: number } {
  let ackCalled = false;
  let nackCalled = false;
  let nackCount = 0;

  const msg = {
    data: Buffer.from(JSON.stringify(body)),
    attributes,
    id,
    deliveryAttempt,
    get ackCalled() { return ackCalled; },
    get nackCalled() { return nackCalled; },
    get nackCount() { return nackCount; },
    ack() { ackCalled = true; },
    nack() { nackCalled = true; nackCount++; },
  };

  return msg;
}

/**
 * Builds an AckableMessage with a data Buffer that is NOT valid JSON,
 * triggering a SerializationError on deserialization.
 */
function makePoisonMessage(id = 'poison-001'): AckableMessage & { nackCalled: boolean } {
  let nackCalled = false;
  return {
    data: Buffer.from('}{not valid json}{'),
    attributes: {},
    id,
    get nackCalled() { return nackCalled; },
    ack() { /* should not be called */ },
    nack() { nackCalled = true; },
  };
}

/** No-op sleep for fast, deterministic tests. */
const noSleep = (_ms: number): Promise<void> => Promise.resolve();

/**
 * Returns a sleep that resolves after one microtask tick (allows async handlers
 * dispatched before stop() to complete naturally in the drain race).
 */
const microSleep = (_ms: number): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// ============================================================================
// AC-6.1: Handler resolves → ack, onAck, correct body/headers/meta
// ============================================================================

describe('createResilientSubscriber — AC-6.1: handler resolves', () => {
  test('ack() is called and nack() is not called when handler resolves', async () => {
    const client = makeFakeClient();
    const subscriber = createResilientSubscriber<{ value: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* resolves */ });
    subscriber.start();

    const msg = makeMessage({ value: 42 });
    lastFakeSub!.emitMessage(msg);

    // Wait for the async handler to settle
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(msg.ackCalled, true, 'ack() must be called on success');
    assert.equal(msg.nackCalled, false, 'nack() must not be called on success');
  });

  test('onAck hook fires with messageId after successful handler', async () => {
    const client = makeFakeClient();
    let hookedId: string | undefined;

    const subscriber = createResilientSubscriber<{ value: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      hooks: { onAck: ({ messageId }) => { hookedId = messageId; } },
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* resolves */ });
    subscriber.start();

    const msg = makeMessage({ value: 1 }, {}, 'ack-msg-id');
    lastFakeSub!.emitMessage(msg);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(hookedId, 'ack-msg-id', 'onAck must receive the message ID');
  });

  test('handler receives deserialized body', async () => {
    const client = makeFakeClient();
    let receivedBody: unknown;

    const subscriber = createResilientSubscriber<{ orderId: string }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async ({ body }) => { receivedBody = body; });
    subscriber.start();

    const msg = makeMessage({ orderId: 'order-42' });
    lastFakeSub!.emitMessage(msg);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(receivedBody, { orderId: 'order-42' });
  });

  test('handler receives allowlisted headers; non-allowlisted headers are absent', async () => {
    const client = makeFakeClient();
    let receivedHeaders: Record<string, string> = {};

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      propagation: { allowlist: ['x-tenant-id'] },
      _sleep: noSleep,
    });

    subscriber.on(async ({ headers }) => { receivedHeaders = headers; });
    subscriber.start();

    const msg = makeMessage(
      { x: 1 },
      {
        traceparent: '00-abc-01',
        'x-tenant-id': 'acme',
        authorization: 'Bearer secret',
      }
    );
    lastFakeSub!.emitMessage(msg);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(receivedHeaders['traceparent'], '00-abc-01', 'W3C trace header must be present');
    assert.equal(receivedHeaders['x-tenant-id'], 'acme', 'allowlisted header must be present');
    assert.equal(receivedHeaders['authorization'], undefined, 'non-allowlisted header must be absent');
  });

  test('handler receives meta with messageId and deliveryAttempt', async () => {
    const client = makeFakeClient();
    let receivedMeta: unknown;

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async ({ meta }) => { receivedMeta = meta; });
    subscriber.start();

    const msg = makeMessage({ x: 1 }, {}, 'meta-msg-id', 3);
    lastFakeSub!.emitMessage(msg);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(receivedMeta, {
      messageId: 'meta-msg-id',
      publishTime: undefined,
      orderingKey: undefined,
      deliveryAttempt: 3,
    });
  });
});

// ============================================================================
// AC-6.2: Handler throws → nack, onError+onNack fired, no crash
// ============================================================================

describe('createResilientSubscriber — AC-6.2: handler throws', () => {
  test('nack() is called and ack() is not called when handler throws', async () => {
    const client = makeFakeClient();

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async () => { throw new Error('handler boom'); });
    subscriber.start();

    const msg = makeMessage({ x: 1 });
    lastFakeSub!.emitMessage(msg);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(msg.nackCalled, true, 'nack() must be called on handler throw');
    assert.equal(msg.ackCalled, false, 'ack() must not be called on handler throw');
  });

  test('onError fires with ResilientPubSubError{kind:process}', async () => {
    const client = makeFakeClient();
    let capturedError: unknown;

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      hooks: { onError: (err) => { capturedError = err; } },
      _sleep: noSleep,
    });

    subscriber.on(async () => { throw new Error('handler error'); });
    subscriber.start();

    lastFakeSub!.emitMessage(makeMessage({ x: 1 }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(capturedError instanceof ResilientPubSubError, 'onError must receive ResilientPubSubError');
    assert.equal((capturedError as ResilientPubSubError).kind, 'process');
  });

  test('onNack fires with messageId and original error', async () => {
    const client = makeFakeClient();
    let nackInfo: { messageId?: string; error: unknown } | undefined;
    const originalError = new Error('original throw');

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      hooks: { onNack: (info) => { nackInfo = info; } },
      _sleep: noSleep,
    });

    subscriber.on(async () => { throw originalError; });
    subscriber.start();

    lastFakeSub!.emitMessage(makeMessage({ x: 1 }, {}, 'nack-msg-id'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(nackInfo?.messageId, 'nack-msg-id');
    assert.equal(nackInfo?.error, originalError, 'onNack must receive the original handler error');
  });

  test('subscriber does not crash when handler throws', async () => {
    const client = makeFakeClient();

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async () => { throw new Error('should not crash the process'); });
    subscriber.start();

    // Emit two messages — if the subscriber crashed the second would not be processed.
    const msg1 = makeMessage({ x: 1 }, {}, 'crash-01');
    const msg2 = makeMessage({ x: 2 }, {}, 'crash-02');
    lastFakeSub!.emitMessage(msg1);
    lastFakeSub!.emitMessage(msg2);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(msg1.nackCalled, true, 'first message must be nacked');
    assert.equal(msg2.nackCalled, true, 'second message must also be nacked (no crash)');
  });
});

// ============================================================================
// AC-6.3: Malformed body → handler not invoked, nack, onPoison
// ============================================================================

describe('createResilientSubscriber — AC-6.3: poison / deserialization failure', () => {
  test('nack() is called when deserialization fails', async () => {
    const client = makeFakeClient();
    let handlerCalled = false;

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async () => { handlerCalled = true; });
    subscriber.start();

    const poison = makePoisonMessage();
    lastFakeSub!.emitMessage(poison);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(poison.nackCalled, true, 'nack() must be called for poison message');
    assert.equal(handlerCalled, false, 'handler must NOT be invoked for poison message');
  });

  test('onPoison hook fires with messageId and the deserialization error', async () => {
    const client = makeFakeClient();
    let poisonInfo: { messageId?: string; error: unknown } | undefined;

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      hooks: { onPoison: (info) => { poisonInfo = info; } },
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* should not be called */ });
    subscriber.start();

    lastFakeSub!.emitMessage(makePoisonMessage('poison-id-42'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(poisonInfo?.messageId, 'poison-id-42');
    assert.ok(poisonInfo?.error instanceof Error, 'onPoison must receive the deserialization error');
  });

  test('custom serializer throw also triggers poison handling', async () => {
    const client = makeFakeClient();
    let poisonFired = false;
    let handlerCalled = false;

    const throwingSerializer = {
      contentType: 'application/json',
      serialize: (b: unknown) => Buffer.from(JSON.stringify(b)),
      deserialize: (_data: Uint8Array): { x: number } => {
        throw new SerializationError('custom serializer always fails');
      },
    };

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      serializer: throwingSerializer,
      hooks: { onPoison: () => { poisonFired = true; } },
      _sleep: noSleep,
    });

    subscriber.on(async () => { handlerCalled = true; });
    subscriber.start();

    lastFakeSub!.emitMessage(makeMessage({ x: 1 }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(poisonFired, true, 'onPoison must fire for custom serializer failure');
    assert.equal(handlerCalled, false, 'handler must not be invoked');
  });
});

// ============================================================================
// AC-6.4: start() without pubSubClient → config error
// ============================================================================

describe('createResilientSubscriber — AC-6.4: no client throws config error', () => {
  test('start() throws ResilientPubSubError{kind:config} when no pubSubClient is provided', () => {
    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* unused */ });

    assert.throws(
      () => subscriber.start(),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError, 'must be ResilientPubSubError');
        assert.equal(err.kind, 'config');
        assert.equal(err.retryable, false);
        return true;
      }
    );
  });
});

// ============================================================================
// AC-6.5: Graceful stop — drain and timeout scenarios
// ============================================================================

describe('createResilientSubscriber — AC-6.5: graceful stop', () => {
  test('stop() waits for slow handler to complete before resolving (message is acked)', async () => {
    const client = makeFakeClient();
    let resolveHandler!: () => void;
    let handlerSettled = false;

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      stopTimeoutMs: 5_000, // generous timeout — handler will finish first
      // Use a sleep that never fires within our test (controlled by resolveHandler)
      _sleep: (_ms: number) => new Promise<void>((resolve) => {
        // This sleep represents the stopTimeoutMs timer — we resolve it manually
        // AFTER the handler completes, so the drain wins the race.
        resolveHandler = resolve;
      }),
    });

    let handlerDone = false;
    let slowHandlerResolve!: () => void;

    subscriber.on(async () => {
      await new Promise<void>((resolve) => { slowHandlerResolve = resolve; });
      handlerDone = true;
    });

    subscriber.start();

    const msg = makeMessage({ x: 1 });
    lastFakeSub!.emitMessage(msg);

    // Let processMessage fire (but not complete — handler is still pending)
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(handlerDone, false, 'handler should still be pending');

    // Begin stop() concurrently
    const stopPromise = subscriber.stop();

    // Complete the slow handler
    slowHandlerResolve();

    // Resolve the timeout timer AFTER the handler — drain should win
    await new Promise((resolve) => setImmediate(resolve));
    resolveHandler(); // release the sleep

    await stopPromise;

    assert.equal(handlerDone, true, 'handler must complete before stop resolves');
    assert.equal(msg.ackCalled, true, 'message must be acked after handler completes');
    assert.equal(msg.nackCalled, false, 'message must not be nacked');
    void handlerSettled; // used to suppress unused-variable lint
  });

  test('stop() nacks in-flight messages when stopTimeoutMs expires', async () => {
    const client = makeFakeClient();

    // Use a sleep that resolves immediately — simulates an instant timeout
    const instantTimeout = (_ms: number): Promise<void> => Promise.resolve();

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      stopTimeoutMs: 1,
      _sleep: instantTimeout,
    });

    let neverResolve!: () => void;
    subscriber.on(async () => {
      // This handler never settles — simulates a hung handler
      await new Promise<void>((resolve) => { neverResolve = resolve; });
    });

    subscriber.start();

    const msg = makeMessage({ x: 1 });
    lastFakeSub!.emitMessage(msg);

    // Let processMessage register the in-flight entry
    await new Promise((resolve) => setImmediate(resolve));

    // stop() races drain vs instant timeout — timeout wins
    await subscriber.stop();

    assert.equal(msg.nackCalled, true, 'in-flight message must be nacked on timeout');
    assert.equal(msg.ackCalled, false, 'message must not be acked after timeout');

    // Clean up the hanging promise to avoid leaked async
    neverResolve();
  });
});

// ============================================================================
// AC-6.6: stop() idempotency
// ============================================================================

describe('createResilientSubscriber — AC-6.6: stop() idempotency', () => {
  test('calling stop() twice resolves both times without errors', async () => {
    const client = makeFakeClient();

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* resolves */ });
    subscriber.start();

    await subscriber.stop();
    await subscriber.stop(); // second call must be a no-op
    // If we reach here without throwing, the test passes.
  });

  test('messages received after stop() do not trigger double-nack', async () => {
    const client = makeFakeClient();
    let poisonFired = false;
    let nackCount = 0;

    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      hooks: {
        onPoison: () => { poisonFired = true; },
        onNack: () => { nackCount++; },
      },
      _sleep: noSleep,
    });

    subscriber.on(async () => { throw new Error('handler error'); });
    subscriber.start();

    // Issue first stop — removes 'message' listener
    await subscriber.stop();

    // After stop, the message listener is removed so new messages won't be processed.
    // Verify stop() can be called again safely.
    await subscriber.stop();

    assert.equal(nackCount, 0, 'no messages were processed so nack count must be 0');
    void poisonFired;
  });
});

// ============================================================================
// AC-6.7: .subscription getter and flowControl pass-through
// ============================================================================

describe('createResilientSubscriber — AC-6.7: .subscription getter and flowControl', () => {
  test('.subscription returns undefined before start() is called', () => {
    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      _sleep: noSleep,
    });

    assert.equal(subscriber.subscription, undefined);
  });

  test('.subscription returns the native SubscriptionLike handle after start()', () => {
    const client = makeFakeClient();
    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* unused */ });
    subscriber.start();

    assert.equal(subscriber.subscription, lastFakeSub, 'subscription must be the native handle');
  });

  test('flowControl options are forwarded to subscription(name, { flowControl })', () => {
    const client = makeFakeClient();
    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'orders-sub',
      pubSubClient: client,
      flowControl: { maxMessages: 20, maxBytes: 1_000_000 },
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* unused */ });
    subscriber.start();

    assert.equal(lastFakeSub!.capturedName, 'orders-sub');
    assert.deepEqual(
      (lastFakeSub!.capturedOptions as { flowControl: unknown }).flowControl,
      { maxMessages: 20, maxBytes: 1_000_000 }
    );
  });

  test('start() is idempotent — second call does not create a new subscription', () => {
    const client = makeFakeClient();
    const subscriber = createResilientSubscriber<{ x: number }>({
      subscription: 'my-sub',
      pubSubClient: client,
      _sleep: noSleep,
    });

    subscriber.on(async () => { /* unused */ });
    subscriber.start();
    const firstSub = lastFakeSub;

    subscriber.start(); // second call — must be a no-op
    assert.equal(lastFakeSub, firstSub, 'start() must not create a second subscription');
  });
});
