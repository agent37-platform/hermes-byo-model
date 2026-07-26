import { requireAgentAccess } from "@/lib/auth";
import { rotateProxyToken } from "@/lib/bootstrap";
import { ApiError, handleError, json } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

// Rotate this agent's proxy token: mint a new one, rewrite the instance's config, restart. The old
// token stops working immediately, so the agent can't chat for the ~30s the restart takes.
export async function POST(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    await requireAgentAccess(id, "admin");

    try {
      await rotateProxyToken(id);
    } catch (e) {
      throw new ApiError(502, "rotate_failed", e instanceof Error ? e.message : "Could not rotate the token.");
    }

    return json({ rotated: true });
  } catch (e) {
    return handleError(e);
  }
}
