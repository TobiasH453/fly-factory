/// <reference lib="webworker" />
import { BrainHost } from "./host";
import type { FromBrain, ToBrain } from "./types";

declare const self: DedicatedWorkerGlobalScope;

let host: BrainHost | null = null;
const pending: ToBrain[] = [];

function post(msg: FromBrain, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<ToBrain>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    try {
      host = new BrainHost(msg.brain, msg.meta, (f) =>
        post({ type: "frame", ...f }, [f.popRates.buffer, f.spikes.buffer, f.spikeCounts.buffer]),
      );
      for (const m of pending) host.handle(m);
      post({ type: "ready", n: host.engine.n, nnz: host.engine.c.nnz, popNames: host.popNames });
      const loop = () => {
        host!.pump(performance.now());
        setTimeout(loop, 2);
      };
      loop();
    } catch (err) {
      post({ type: "error", message: String(err) });
    }
    return;
  }
  if (host) host.handle(msg);
  else pending.push(msg);
};
