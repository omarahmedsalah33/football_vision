import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../db/client";
import { invalidInput } from "../http/errors";
import { organizations, users } from "../db/schema";
import { resolveActor } from "../orgs/service";
import { createPlayer, myPlayer, playerInput } from "../players/service";

export const onboardingInput = z.discriminatedUnion("persona", [
  // A player sets up their own profile straight away; everyone else just picks how they'll use it.
  z.object({ persona: z.literal("player"), profile: playerInput }),
  z.object({ persona: z.enum(["coach", "club", "scout", "parent"]) }),
  // "Skip for now": straight to the workspace, nothing recorded about how it'll be used.
  z.object({ persona: z.literal("skip") }),
]);

/** Records how the user will use the product and, for players, creates their own profile. */
export async function completeOnboarding(db: DbOrTx, userId: string, raw: z.input<typeof onboardingInput>) {
  const parsed = onboardingInput.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error.issues[0]?.message ?? "Check your details.");
  const input = parsed.data;
  const [personal] = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(and(eq(organizations.personalOwnerId, userId), eq(organizations.kind, "personal")));
  if (!personal) throw new Error("personal workspace missing");
  let next = `/app/${personal.slug}`;
  if (input.persona === "player") {
    const actor = await resolveActor(db, userId, personal.id);
    const existing = await myPlayer(db, actor);
    const player = existing ?? (await createPlayer(db, actor, input.profile, { me: true }));
    next = `/app/${personal.slug}/players/${player.id}`;
  } else if (input.persona === "club" || input.persona === "coach") {
    next = "/app/new";
  }
  await db
    .update(users)
    .set({ persona: input.persona === "skip" ? null : input.persona, onboardedAt: new Date() })
    .where(eq(users.id, userId));
  return { next };
}
