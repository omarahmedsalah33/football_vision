import { getDb } from "@/server/db/client";
import { route } from "@/server/http/route";
import { completeOnboarding, onboardingInput } from "@/server/onboarding/service";

export const POST = route<Record<string, never>, typeof onboardingInput>({ body: onboardingInput }, async ({ user, body }) => {
  return completeOnboarding(getDb(), user.id, body);
});
