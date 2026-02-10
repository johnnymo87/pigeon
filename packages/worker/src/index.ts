export { RouterDurableObject } from "./router-do";

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
} satisfies ExportedHandler<Env>;
