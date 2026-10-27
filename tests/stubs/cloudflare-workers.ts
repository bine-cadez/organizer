/** Node test stand-in for the workerd module. Production uses the real export. */
export class DurableObject<T = unknown> {
  ctx: DurableObjectState;
  env: T;
  constructor(ctx: DurableObjectState, env: T) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class WorkerEntrypoint<T = unknown> {
  ctx: ExecutionContext;
  env: T;
  constructor(ctx: ExecutionContext, env: T) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class RpcTarget {}
export class WorkflowEntrypoint {}
export const env = {};
export const exports = {};
