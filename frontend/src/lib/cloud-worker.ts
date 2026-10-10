// Transport only. Rust owns password policy, cryptography and owner validation.
export type OwnerContext = { passwordBoxId: string; ownerAccountId: string; keyEpoch: number };
export type ItemContext = { passwordBoxId: string; itemId: string; itemVersion: number; keyEpoch: number };
export type AccountContext = { accountId: string; identityVersion: number };
export type PublicIdentity = AccountContext & { publicKey: string; keyId: string };
export type SharedContext = { passwordBoxId: string; senderAccountId: string; recipientAccountId: string;
  keyEpoch: number; senderIdentityVersion: number; recipientIdentityVersion: number; senderKeyId: string; recipientKeyId: string };
type Reply = { version: number; requestId: number | null; generation: number; locked: boolean; identityLocked: boolean; ok: boolean; error?: string; bundle?: string; envelope?: string; item?: string; recovery?: string; publicIdentity?: string; sharedContext?: string; identityPrepared?: string };
type Command = "generate" | "wrap" | "unlock" | "recover" | "recoveryMaterial" | "create" | "edit" | "encrypt" | "decrypt" |
  "identityGenerate" | "identityPublic" | "identityWrap" | "identityUnlock" | "identityPrepare" | "verifyPublicIdentity" | "sharingContext" | "sharedRecipientWrap" | "sharedReceiveUnlock";
const MAX_BODY = 1024 * 1024;
const MAX_ENVELOPE = 1_500_000;
const MAX_MESSAGE = MAX_BODY * 6 + 4096;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const utf8Size = (text: string) => new TextEncoder().encode(text).byteLength;

export class CloudWorkerError extends Error {
  constructor() { super("Cloud worker unavailable or request rejected"); }
}

export class CloudWorker {
  private worker: Worker | null = null;
  private generation = 0;
  private requestId = 0;
  private stopped = false;
  private opened = false;
  private identityOpened = false;
  private pending: { id: number; command: Command; generation: number; resolve: (reply: Reply) => void; reject: (error: CloudWorkerError) => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastInput: { monotonic: number; wall: number } | null = null;
  private readonly inputEvents = ["pointerdown", "keydown", "wheel", "click", "beforeinput", "input", "submit"] as const;
  private readonly input = (event: Event) => {
    if (!event.isTrusted || document.visibilityState !== "visible" || !this.lastInput) return;
    // Check the old deadline before input can extend it. Consume the first
    // expired input before a React handler could reveal or submit plaintext.
    if (this.expireIdle()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    this.markInput();
  };
  private readonly background = () => { if (document.visibilityState === "hidden") this.dispose(); };
  private readonly leave = () => this.dispose();
  private readyResolve!: () => void;
  private readyReject!: (error: CloudWorkerError) => void;
  private readyReceived = false;
  private closedResolve!: () => void;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  get isClosed(): boolean { return this.stopped; }
  get isBusy(): boolean { return this.pending !== null; }

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
      for (const type of this.inputEvents) window.addEventListener(type, this.input, { capture: true, passive: false });
      document.addEventListener("visibilitychange", this.background);
      for (const type of ["pagehide", "passshare:cloud-lock"]) window.addEventListener(type, this.leave);
      this.armTimeout();
    } catch { this.dispose(); }
  }

  private armTimeout() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dispose(), 60_000);
  }

  private markInput() {
    this.lastInput = { monotonic: performance.now(), wall: Date.now() };
    this.armIdleTimeout();
  }

  private armIdleTimeout() {
    clearTimeout(this.idleTimer);
    if (!this.lastInput) return;
    const elapsed = Math.max(performance.now() - this.lastInput.monotonic, Date.now() - this.lastInput.wall);
    this.idleTimer = setTimeout(() => {
      // A timer may run early; preserve the deadline rather than renew it.
      if (!this.expireIdle()) this.armIdleTimeout();
    }, Math.max(1, IDLE_TIMEOUT_MS - elapsed));
  }

  private expireIdle(): boolean {
    if (!this.lastInput) return this.stopped;
    const monotonic = performance.now() - this.lastInput.monotonic;
    const wall = Date.now() - this.lastInput.wall;
    // Some platforms pause the monotonic clock during sleep. Either elapsed
    // clock expires the session; a backwards clock change also requires unlock.
    if (monotonic >= IDLE_TIMEOUT_MS || wall >= IDLE_TIMEOUT_MS || monotonic < 0 || wall < 0) {
      this.dispose();
      lockCloudUi();
      return true;
    }
    return false;
  }

  private receive(data: unknown) {
    if (this.stopped || this.expireIdle()) return;
    let reply: Reply;
    try {
      if (typeof data !== "string" || data.length > MAX_MESSAGE || utf8Size(data) > MAX_MESSAGE) throw new CloudWorkerError();
      reply = JSON.parse(data) as Reply;
      if (!reply || typeof reply !== "object" || Array.isArray(reply) ||
        Object.keys(reply).some((key) => !["version", "requestId", "generation", "locked", "identityLocked", "ok", "error", "bundle", "envelope", "item", "recovery", "publicIdentity", "sharedContext", "identityPrepared"].includes(key)) ||
        (reply.requestId !== null && (!Number.isSafeInteger(reply.requestId) || reply.requestId <= 0)) ||
        (reply.error !== undefined && !["PS051: Invalid encrypted data", "PS057: Password box is locked", "PS057: Account identity is locked",
          "PS058: Stale worker generation", "PS059: Password box is already open"].includes(reply.error)) ||
        (reply.bundle !== undefined && (typeof reply.bundle !== "string" || utf8Size(reply.bundle) > 2048)) ||
        (reply.envelope !== undefined && (typeof reply.envelope !== "string" || utf8Size(reply.envelope) > MAX_ENVELOPE)) ||
        (reply.item !== undefined && (typeof reply.item !== "string" || utf8Size(reply.item) > MAX_BODY)) ||
        (reply.recovery !== undefined && (typeof reply.recovery !== "string" || utf8Size(reply.recovery) > 4096)) ||
        (reply.publicIdentity !== undefined && (typeof reply.publicIdentity !== "string" || utf8Size(reply.publicIdentity) > 512)) ||
        (reply.sharedContext !== undefined && (typeof reply.sharedContext !== "string" || utf8Size(reply.sharedContext) > 1024)) ||
        (reply.identityPrepared !== undefined && (typeof reply.identityPrepared !== "string" || utf8Size(reply.identityPrepared) > 8192))) throw new CloudWorkerError();
      if (reply.version !== 1 || !Number.isSafeInteger(reply.generation) || reply.generation < 0 ||
        typeof reply.locked !== "boolean" || typeof reply.identityLocked !== "boolean" || typeof reply.ok !== "boolean") throw new CloudWorkerError();
    } catch { this.dispose(); return; }
    if (!this.readyReceived) {
      if (reply.requestId !== null || reply.generation !== 0 || !reply.locked || !reply.identityLocked || !reply.ok ||
        reply.error !== undefined || reply.bundle !== undefined || reply.envelope !== undefined || reply.item !== undefined || reply.recovery !== undefined || reply.publicIdentity !== undefined || reply.sharedContext !== undefined || reply.identityPrepared !== undefined) { this.dispose(); return; }
      this.readyReceived = true;
      clearTimeout(this.timer);
      this.readyResolve();
      return;
    }
    const pending = this.pending;
    if (!pending || reply.requestId !== pending.id) { this.dispose(); return; }
    const opens = ["generate", "unlock", "recover", "sharedReceiveUnlock"].includes(pending.command);
    const opensIdentity = ["identityGenerate", "identityUnlock", "identityPrepare"].includes(pending.command);
    const payload = pending.command === "identityPrepare" ? "identityPrepared" : pending.command === "sharingContext" ? "sharedContext" : ["identityGenerate", "identityUnlock", "identityPublic", "verifyPublicIdentity"].includes(pending.command) ? "publicIdentity" :
      pending.command === "recoveryMaterial" ? "recovery" : ["wrap", "identityWrap"].includes(pending.command) ? "bundle" : pending.command === "decrypt" ? "item" :
      ["create", "edit", "encrypt", "sharedRecipientWrap"].includes(pending.command) ? "envelope" : null;
    if ((reply.ok ? reply.error !== undefined : typeof reply.error !== "string") ||
      (["bundle", "envelope", "item", "recovery", "publicIdentity", "sharedContext", "identityPrepared"] as const).some((key) =>
        reply.ok && key === payload ? typeof reply[key] !== "string" : reply[key] !== undefined)) { this.dispose(); return; }
    const expected = pending.generation + (reply.ok && (opens || opensIdentity) ? 1 : 0);
    if (reply.generation !== expected || reply.locked !== !(this.opened || (reply.ok && opens)) ||
      reply.identityLocked !== !(this.identityOpened || (reply.ok && opensIdentity))) { this.dispose(); return; }
    this.pending = null;
    clearTimeout(this.timer);
    this.generation = reply.generation;
    if (reply.ok && opens) this.opened = true;
    if (reply.ok && opensIdentity) this.identityOpened = true;
    // Only the first private handle starts the deadline. Later crypto/HTTP
    // traffic, including opening the other handle, never extends it.
    if (reply.ok && (opens || opensIdentity) && !this.lastInput) this.markInput();
    if (reply.ok) pending.resolve(reply);
    else pending.reject(new CloudWorkerError());
  }

  private async send(command: Command, fields: Record<string, string>): Promise<Reply> {
    try {
      await this.ready;
      if (this.stopped || this.expireIdle() || !this.worker || this.pending) throw new CloudWorkerError();
      // Opening an already-open handle is a caller error, not a reason to
      // destroy the valid key or decrypted draft. Rust also rejects replacement.
      if (this.opened && ["generate", "unlock", "recover", "sharedReceiveUnlock"].includes(command)) throw new CloudWorkerError();
      if (this.identityOpened && ["identityGenerate", "identityUnlock", "identityPrepare"].includes(command)) throw new CloudWorkerError();
      for (const key of ["item", "values", "envelope", "context"] as const) {
        const limit = key === "envelope" ? MAX_ENVELOPE : key === "context" ? 512 : MAX_BODY;
        if (key in fields && (typeof fields[key] !== "string" || utf8Size(fields[key]) > limit)) throw new CloudWorkerError();
      }
      if (this.requestId >= Number.MAX_SAFE_INTEGER) throw new CloudWorkerError();
      const id = ++this.requestId;
      return new Promise((resolve, reject) => {
        this.pending = { id, command, generation: this.generation, resolve, reject };
        this.armTimeout();
        try {
          const message = JSON.stringify({ version: 1, requestId: id, command, expectedGeneration: this.generation, ...fields });
          if (utf8Size(message) > MAX_MESSAGE) throw new CloudWorkerError();
          this.worker!.postMessage(message);
        } catch { this.dispose(); }
      });
    } finally { for (const key of ["values", "item", "password", "identitySecret", "verificationCode"]) if (key in fields) fields[key] = ""; }
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
  // Client-only material: callers must separate and clear the returned code.
  createRecoveryMaterial(): Promise<string> {
    return this.send("recoveryMaterial", {}).then((reply) => reply.recovery!);
  }
  recover(owner: OwnerContext, bundle: string, recoveryCode: string): Promise<void> {
    return this.send("recover", { owner: JSON.stringify(owner), bundle, password: recoveryCode }).then(() => {});
  }
  createItem(valuesJSON: string): Promise<string> {
    return this.send("create", { values: valuesJSON }).then((reply) => reply.envelope!);
  }
  editItem(originalFullJSON: string, valuesJSON: string, nextItemContext: ItemContext): Promise<string> {
    return this.send("edit", { item: originalFullJSON, values: valuesJSON, context: JSON.stringify(nextItemContext) }).then((reply) => reply.envelope!);
  }
  encrypt(itemJSON: string, context: ItemContext): Promise<string> {
    return this.send("encrypt", { item: itemJSON, context: JSON.stringify(context) }).then((reply) => reply.envelope!);
  }
  decrypt(envelopeJSON: string, context: ItemContext): Promise<string> {
    return this.send("decrypt", { envelope: envelopeJSON, context: JSON.stringify(context) }).then((reply) => reply.item!);
  }

  generateIdentity(context: AccountContext): Promise<string> {
    return this.send("identityGenerate", { accountContext: JSON.stringify(context) }).then((r) => r.publicIdentity!);
  }
  publicIdentity(): Promise<string> { return this.send("identityPublic", {}).then((r) => r.publicIdentity!); }
  prepareIdentity(values: string, identitySecret: string): Promise<{ publicIdentity: string; record: string; requiresCreate: boolean; hasPending: boolean }> {
    return this.send("identityPrepare", { values, identitySecret }).then((r) => {
      const prepared = JSON.parse(r.identityPrepared!);
      if (!prepared || Object.keys(prepared).length !== 4 || typeof prepared.publicIdentity !== "string" ||
        typeof prepared.record !== "string" || typeof prepared.requiresCreate !== "boolean" || typeof prepared.hasPending !== "boolean") {
        this.dispose(); throw new CloudWorkerError();
      }
      return prepared;
    });
  }
  wrapIdentity(identitySecret: string): Promise<string> {
    return this.send("identityWrap", { identitySecret }).then((r) => r.bundle!);
  }
  unlockIdentity(context: AccountContext, expectedKeyId: string, bundle: string, identitySecret: string): Promise<string> {
    return this.send("identityUnlock", { accountContext: JSON.stringify(context), expectedKeyId, bundle, identitySecret }).then((r) => r.publicIdentity!);
  }
  verifyPublicIdentity(context: AccountContext, publicIdentity: string, verificationCode: string): Promise<string> {
    return this.send("verifyPublicIdentity", { accountContext: JSON.stringify(context), publicIdentity, verificationCode }).then((r) => r.publicIdentity!);
  }
  wrapForRecipient(trustedRecipientPublic: string, context: SharedContext): Promise<string> {
    return this.send("sharedRecipientWrap", { trustedRecipientPublic, sharedContext: JSON.stringify(context) }).then((r) => r.envelope!);
  }
  sharingContext(selectionJSON: string): Promise<SharedContext> {
    return this.send("sharingContext", { values: selectionJSON }).then((r) => JSON.parse(r.sharedContext!) as SharedContext);
  }
  receiveShared(envelope: string, trustedSenderPublic: string, context: SharedContext): Promise<void> {
    return this.send("sharedReceiveUnlock", { envelope, trustedSenderPublic, sharedContext: JSON.stringify(context) }).then(() => {});
  }

  // Immediate invalidation; termination does not promise a memory-wide wipe.
  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    this.opened = false;
    this.identityOpened = false;
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
    this.lastInput = null;
    for (const type of this.inputEvents) window.removeEventListener(type, this.input, true);
    document.removeEventListener("visibilitychange", this.background);
    for (const type of ["pagehide", "passshare:cloud-lock"]) window.removeEventListener(type, this.leave);
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
