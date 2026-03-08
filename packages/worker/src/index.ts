import { RouterDurableObject } from "./router-do";
import { cleanupExpiredMedia } from "./media";

export { RouterDurableObject };
export class RouterDO extends RouterDurableObject {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // All other routes go through the Durable Object
    const id = env.ROUTER.idFromName("singleton");
    const stub = env.ROUTER.get(id);
    return stub.fetch(request);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await cleanupExpiredMedia(env);
  },
} satisfies ExportedHandler<Env>;
