/**
 * Cooperative cancellation coordinator (#66). The worker registers an
 * `AbortController` per in-flight job and threads its signal into the inference
 * HTTP stream and the capture sandbox. On `DELETE /jobs/:id`, after the store is
 * flipped to `cancelling`, `cancel(jobId)` aborts the inference stream and tears
 * down the microVM (the injected `killSandbox` seam — real Fly Machines stop is
 * wired in #22). Teardown is best-effort: correctness never depends on the kill
 * landing in time (the no-result invariant comes from `complete`/`fail` only
 * acting on `running` rows).
 */
export type SandboxKill = (jobId: string) => Promise<void>;

export class CancellationCoordinator {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly killSandbox: SandboxKill = async () => undefined) {}

  /** Register an in-flight job; returns the AbortSignal to thread into inference + capture. */
  register(jobId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller.signal;
  }

  /** Best-effort teardown: abort the inference stream + stop the microVM. Never throws. */
  async cancel(jobId: string): Promise<void> {
    this.controllers.get(jobId)?.abort();
    await this.killSandbox(jobId).catch(() => undefined);
  }

  /** Whether a registered job has been aborted. */
  isAborted(jobId: string): boolean {
    return this.controllers.get(jobId)?.signal.aborted ?? false;
  }

  /** Drop the controller once the job is done (success/fail/canceled). */
  release(jobId: string): void {
    this.controllers.delete(jobId);
  }
}
