import { getAgentByName, routeAgentRequest } from "agents";

export { World } from "./world";
export { KaleAgent } from "./kale-agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/world/")) {
      const id = url.pathname.split("/")[3] || "kale-1";
      const world = await getAgentByName(env.World, id);
      return world.fetch(request);
    }
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;
    return env.ASSETS.fetch(request);
  },
};
