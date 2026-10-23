import { redirect } from "next/navigation";
import { Suspense } from "react";

export default function OrgHome({ params }: PageProps<"/app/[org]">) {
  return (
    <Suspense>
      <ToMatches params={params} />
    </Suspense>
  );
}

async function ToMatches({ params }: { params: PageProps<"/app/[org]">["params"] }): Promise<never> {
  const { org } = await params;
  redirect(`/app/${org}/matches`);
}
