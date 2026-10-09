// Transport only. Rust owns password policy, cryptography and owner validation.
export type OwnerContext = { passwordBoxId: string; ownerAccountId: string; keyEpoch: number };
type Reply = { version: number; requestId: number | null; generation: number; locked: boolean; ok: boolean; bundle?: string };
type Command = "generate" | "wrap" | "unlock";

export class CloudWorkerError extends Error {
  constructor() { super("Cloud worker unavailable or request rejected"); }
}

export class CloudWorker {
  private worker: Worker | null = null;
  private generation = 0;
  private requestId = 0;
  private stopped = false;
  private pending: { id: number; command: Command; generation: number; resolve: (reply: Reply) => void; reject: (error: CloudWorkerError) => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readyResolve!: () => void;
  private readyReject!: (error: CloudWorkerError) => void;
  private readyReceived = false;
  private closedResolve!: () => void;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;

  constructor() {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.closed = new Promise((resolve) => { this.closedResolve = resolve; });
    // Disposal can happen before a caller starts awaiting startup.
    void this.ready.catch(() => {});
    try {
      this.worker = new Worker("/cloud-crypto/boot.mjs", { type: "module" });
      this.worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
      this.worker.onerror = () => this.dispose();
      this.worker.onmessageerror = () => this.dispose();
      this.armTimeout();
    } catch { this.dispose(); }
  }

  private armTimeout() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dispose(), 60_000);
  }

  private receive(data: unknown) {
    if (this.stopped) return;
    let reply: Reply;
    try {
      if (typeof data !== "string") throw new CloudWorkerError();
      reply = JSON.parse(data) as Reply;
      if (reply.version !== 1 || !Number.isSafeInteger(reply.generation) || reply.generation < 0 ||
        typeof reply.locked !== "boolean" || typeof reply.ok !== "boolean") throw new CloudWorkerError();
    } catch { this.dispose(); return; }
    if (!this.readyReceived) {
      if (reply.requestId !== null || reply.generation !== 0 || !reply.locked || !reply.ok) { this.dispose(); return; }
      this.readyReceived = true;
      clearTimeout(this.timer);
      this.readyResolve();
      return;
    }
    const pending = this.pending;
    if (!pending || reply.requestId !== pending.id) { this.dispose(); return; }
    const opens = pending.command === "generate" || pending.command === "unlock";
    const expected = pending.generation + (reply.ok && opens ? 1 : 0);
    if (reply.generation !== expected || reply.locked !== (!reply.ok && opens)) { this.dispose(); return; }
    this.pending = null;
    clearTimeout(this.timer);
    this.generation = reply.generation;
    if (reply.ok) pending.resolve(reply);
    else pending.reject(new CloudWorkerError());
  }

  private async send(command: Command, fields: Record<string, string>): Promise<Reply> {
    try {
      await this.ready;
      if (this.stopped || !this.worker || this.pending) throw new CloudWorkerError();
      const id = ++this.requestId;
      return new Promise((resolve, reject) => {
        this.pending = { id, command, generation: this.generation, resolve, reject };
        this.armTimeout();
        try {
          this.worker!.postMessage(JSON.stringify({ version: 1, requestId: id, command, expectedGeneration: this.generation, ...fields }));
        } catch { this.dispose(); }
      });
    } finally { if ("password" in fields) fields.password = ""; }
  }

  generate(owner: OwnerContext): Promise<void> {
    return this.send("generate", { owner: JSON.stringify(owner) }).then(() => {});
  }
  wrap(password: string): Promise<string> {
    return this.send("wrap", { password }).then((reply) => {
      if (typeof reply.bundle !== "string") { this.dispose(); throw new CloudWorkerError(); }
      return reply.bundle;
    });
  }
  unlock(owner: OwnerContext, bundle: string, password: string): Promise<void> {
    return this.send("unlock", { owner: JSON.stringify(owner), bundle, password }).then(() => {});
  }

  // Immediate invalidation; termination does not promise a memory-wide wipe.
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.pending?.reject(new CloudWorkerError());
    this.pending = null;
    this.readyReject(new CloudWorkerError());
    this.generation = 0;
    this.closedResolve();
  }
}

// Shell logout invalidates secrets before any HTTP request, even if it fails.
export function lockCloudUi() { window.dispatchEvent(new Event("passshare:cloud-lock")); }
