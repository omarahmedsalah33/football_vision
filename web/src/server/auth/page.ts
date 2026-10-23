import "server-only";
import { notFound, redirect } from "next/navigation";
import { AppError } from "../http/errors";
import { requireActor, requireUser } from "./session";

/** Server Component variant of the session helpers: maps auth failures to navigation. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.status === 401) redirect("/sign-in");
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
}

export const pageUser = () => guard(requireUser);
export const pageActor = (orgSlug: string) => guard(() => requireActor(orgSlug));
