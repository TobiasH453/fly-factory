import BrainWorker from "./brain.worker.ts?worker&inline";
import { BrainHost } from "./host";
import type { BrainFrame, BrainMeta, FromBrain, ToBrain } from "./types";

/**
 * Main-thread handle on the fly brain. Runs the simulation in an inline Web Worker,
 * falling back to the main thread if workers are unavailable.
 */
export class BrainClient {
  popNames: string[] = [];
  popIndex: Record<string, number> = {};
  ready = false;
  mode: "worker" | "main-thread" = "worker";
  private worker: Worker | null = null;
  private host: BrainHost | null = null;
  private listeners: ((f: BrainFrame) => void)[] = [];
  private readyResolve!: () => void;
  readonly whenReady = new Promise<void>((r) => (this.readyResolve = r));

  constructor(readonly meta: BrainMeta, brain: ArrayBuffer) {
    try {
      this.worker = new BrainWorker();
      this.worker.onmessage = (ev: MessageEvent<FromBrain>) => this.onMessage(ev.data);
      this.worker.onerror = (e) => {
        console.warn("brain worker failed, using main thread", e);
        this.worker?.terminate();
        this.worker = null;
        this.startMainThread(meta, brain);
      };
      // keep a copy in case the worker dies and we need the fallback
      this.worker.postMessage({ type: "init", brain: brain.slice(0), meta } satisfies ToBrain);
    } catch (e) {
      console.warn("Web Worker unavailable, running brain on main thread", e);
      this.startMainThread(meta, brain);
    }
  }

  private startMainThread(meta: BrainMeta, brain: ArrayBuffer) {
    if (this.host) return;
    this.mode = "main-thread";
    this.host = new BrainHost(brain, meta, (f) => this.listeners.forEach((l) => l(f)));
    this.setPopNames(this.host.popNames);
    const loop = () => {
      this.host!.pump(performance.now());
      setTimeout(loop, 4);
    };
    loop();
  }

  private setPopNames(names: string[]) {
    this.popNames = names;
    this.popIndex = Object.fromEntries(names.map((n, i) => [n, i]));
    this.ready = true;
    this.readyResolve();
  }

  private onMessage(msg: FromBrain) {
    if (msg.type === "ready") this.setPopNames(msg.popNames);
    else if (msg.type === "frame") this.listeners.forEach((l) => l(msg));
    else if (msg.type === "error") console.error("brain error:", msg.message);
  }

  send(msg: ToBrain) {
    if (this.worker) this.worker.postMessage(msg);
    else this.host?.handle(msg);
  }

  onFrame(cb: (f: BrainFrame) => void) {
    this.listeners.push(cb);
  }

  setInputs(rates: Record<string, number>) {
    this.send({ type: "inputs", rates });
  }
  setOpto(pop: string, hz: number) {
    this.send({ type: "opto", pop, hz });
  }
  setSilenced(pop: string, on: boolean) {
    this.send({ type: "silence", pop, on });
  }
  reset() {
    this.send({ type: "reset" });
  }
}
