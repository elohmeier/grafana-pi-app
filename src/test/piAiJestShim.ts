export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;

  constructor(
    private readonly isComplete: (event: T) => boolean,
    private readonly extractResult: (event: T) => R
  ) {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T) {
    if (this.done) {
      return;
    }

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }

    this.queue.push(event);
  }

  end(result?: R) {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  result() {
    return this.finalResultPromise;
  }
}

export function streamSimple(): never {
  throw new Error('streamSimple is not available in Jest tests; pass an explicit streamFn.');
}

export function validateToolArguments(_tool: unknown, toolCall: { arguments: unknown }) {
  return toolCall.arguments;
}

type AssistantStreamEvent = { type: string; message?: unknown; error?: unknown };

export class AssistantMessageEventStream extends EventStream<AssistantStreamEvent, unknown> {
  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => (event.type === 'done' ? event.message : event.error)
    );
  }
}

export function createAssistantMessageEventStream() {
  return new AssistantMessageEventStream();
}
