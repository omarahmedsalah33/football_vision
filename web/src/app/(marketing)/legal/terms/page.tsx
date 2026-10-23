import type { Metadata } from "next";
import Link from "next/link";
import { DraftNotice, PageHero } from "@/components/marketing/site-chrome";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The rules for using Football Vision: accounts, footage rights, acceptable use and AI results.",
};

export default function TermsPage() {
  return (
    <>
      <PageHero eyebrow="Legal" title="Terms of service" />
      <article className="fv-prose mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <DraftNotice>
          These terms reflect how the product works but have not yet been reviewed by a lawyer. They must be
          reviewed, including the governing law and liability sections, before paid plans launch. Items in
          [brackets] are to be completed.
        </DraftNotice>

        <h2>1. The service</h2>
        <p>
          Football Vision (“we”, operated by [legal entity]) lets you upload football match footage and analyse
          it. The service is in early access: features marked “in development” are not available, and features
          may change.
        </p>

        <h2>2. Accounts and workspaces</h2>
        <ul>
          <li>Keep your sign-in details secure; you are responsible for activity under your account.</li>
          <li>
            Workspace owners and admins control who joins their workspace and which role each member has. Roles
            and their permissions are listed in our <Link href="/docs#roles">documentation</Link>.
          </li>
        </ul>

        <h2>3. Your footage and data</h2>
        <ul>
          <li>You keep all rights to the footage and data you upload.</li>
          <li>
            You give us permission to store and process it only to provide the service to you. This permission
            does not include training AI models, which needs your separate, explicit agreement.
          </li>
          <li>
            You confirm you have the rights and consents needed to upload the footage, including consent from
            parents or guardians for players under 18 where the law requires it, and permission from the venue or
            competition where applicable.
          </li>
        </ul>

        <h2>4. Acceptable use</h2>
        <p>You must not:</p>
        <ul>
          <li>upload content you have no right to, or content unrelated to football analysis;</li>
          <li>try to access another workspace&apos;s data, probe or overload the service, or bypass plan limits;</li>
          <li>use results to identify, track or profile people outside the context of the sport;</li>
          <li>use results as the sole basis for decisions with serious effects on a person (for example contracts, selection of minors or medical matters) without human review.</li>
        </ul>

        <h2>5. AI results</h2>
        <p>
          Analysis is produced by computer vision and statistical methods. Each result is labelled as measured,
          estimated, inferred or not available, but results can be wrong. They are decision support, not
          guarantees. Read the <Link href="/ai-limitations">AI limitations</Link> before relying on them.
        </p>

        <h2>6. Plans and payment</h2>
        <p>
          The free plan is available now. Paid plans, prices and payment terms will be published before they go on
          sale. Plan limits are enforced as shown on the <Link href="/pricing">pricing page</Link>; failed or
          cancelled analyses do not count against them.
        </p>

        <h2>7. Availability</h2>
        <p>
          During early access we do not promise a particular uptime or response time. We will try to tell you in
          advance about planned maintenance.
        </p>

        <h2>8. Ending your use</h2>
        <p>
          You can stop using the service and delete your account at any time. We may suspend accounts that break
          these terms. After an account or workspace is deleted, its data is removed as described in the{" "}
          <Link href="/legal/privacy">privacy policy</Link>.
        </p>

        <h2>9. Liability</h2>
        <p>[To be drafted by counsel: limitation of liability, warranties and indemnities appropriate to Egyptian law.]</p>

        <h2>10. Governing law</h2>
        <p>[To be confirmed by counsel; expected to be the laws of the Arab Republic of Egypt.]</p>

        <p className="text-sm">Last updated: 23 October 2026 (draft).</p>
      </article>
    </>
  );
}
