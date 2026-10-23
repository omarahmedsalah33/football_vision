import type { Metadata } from "next";
import Link from "next/link";
import { DraftNotice, PageHero } from "@/components/marketing/site-chrome";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What data Football Vision collects, why, who processes it, how long we keep it and your rights.",
};

export default function PrivacyPage() {
  return (
    <>
      <PageHero eyebrow="Legal" title="Privacy policy">
        Plain-language account of what happens to your data, written to match how the product actually works.
      </PageHero>
      <article className="fv-prose mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <DraftNotice>
          This policy describes our real data practices but has not yet been reviewed by a lawyer. It must be
          reviewed against Egypt&apos;s Personal Data Protection Law (Law No. 151 of 2020) and any other law that
          applies to our customers before Football Vision is offered commercially. Items in [brackets] are to be
          completed.
        </DraftNotice>

        <h2>Who we are</h2>
        <p>
          Football Vision is operated by [legal entity name, registration number, address] (“we”). Contact us
          about privacy through our <Link href="/contact">contact form</Link> (topic: “Privacy or data request”)
          or at [privacy email].
        </p>

        <h2>Our role: controller and processor</h2>
        <p>
          For <strong>your account</strong> we decide how data is used, so we are its controller. For{" "}
          <strong>match footage and analysis</strong> that a club or academy uploads, the club decides what to film
          and upload: the club is the controller and we process that footage on its behalf and on its
          instructions.
        </p>

        <h2>What we collect</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Account: name, email address, sign-in records</td>
              <td>To create and secure your account. Sign-in is handled by our authentication provider.</td>
            </tr>
            <tr>
              <td>Workspace: club names, members, roles</td>
              <td>To decide who can see and do what.</td>
            </tr>
            <tr>
              <td>Match details: titles, opponents, dates</td>
              <td>To organise your matches.</td>
            </tr>
            <tr>
              <td>Match footage, which can show identifiable people, including minors</td>
              <td>To analyse the match for the club that uploaded it.</td>
            </tr>
            <tr>
              <td>Analysis results: positions and movement of tracked players</td>
              <td>To produce the reports the club asked for.</td>
            </tr>
            <tr>
              <td>Usage: number of analyses per month, plan</td>
              <td>To apply plan limits and, once paid plans exist, to bill correctly.</td>
            </tr>
            <tr>
              <td>Contact form messages</td>
              <td>To answer you. We do not store your IP address with them.</td>
            </tr>
            <tr>
              <td>Security logs and abuse protection</td>
              <td>
                To keep the service safe. Rate limits use counters keyed by your account or by a one-way hash of
                your IP address.
              </td>
            </tr>
          </tbody>
        </table>

        <h2>What we never do</h2>
        <ul>
          <li>We never identify people by their face or appearance, and we do not create biometric profiles.</li>
          <li>We never sell personal data or use it for advertising.</li>
          <li>
            We never use your footage to train or improve AI models without your explicit, separate permission.
            Using the service does not give us that permission.
          </li>
        </ul>

        <h2>Children</h2>
        <p>
          Academies often film players under 18. Before uploading such footage, the club must have the consent of
          each player&apos;s parent or guardian where the law requires it. We process this footage only for the
          club, keep it private to the club&apos;s workspace, and delete it when the club deletes it or its
          retention period ends.
        </p>

        <h2>Who processes data for us</h2>
        <ul>
          <li>Authentication provider (Clerk) for sign-in and account security.</li>
          <li>Cloud hosting and private object storage for the application and footage: [providers and regions].</li>
          <li>Later, when introduced and listed here before use: a payment provider and an AI language-model provider for the match assistant.</li>
        </ul>
        <p>
          Some providers may process data outside Egypt. We use them under contracts that require appropriate
          protection [transfer mechanism to be confirmed by counsel].
        </p>

        <h2>How long we keep data</h2>
        <ul>
          <li>Footage: for your plan&apos;s retention period (shown on the pricing page), or until you delete it.</li>
          <li>Analysis results: as long as the match exists in your workspace.</li>
          <li>Account data: until you delete your account, then removed within [30] days, except where the law requires us to keep records.</li>
          <li>Backups: overwritten on a rolling basis within [35] days.</li>
        </ul>

        <h2>How we protect it</h2>
        <p>
          Private storage with short-lived access links, encryption in transit, strict separation between
          workspaces enforced on our servers, role-based permissions, and security testing as part of every change.
          No system is perfectly secure; we will notify affected customers and authorities of a breach as the law
          requires.
        </p>

        <h2>Your rights</h2>
        <p>
          You can ask to access, correct or delete your personal data, object to or restrict its processing, and
          receive a copy of it. For footage uploaded by a club, contact that club first; we will help them respond.
          You can also complain to Egypt&apos;s Personal Data Protection Center or your local data protection
          authority.
        </p>

        <h2>Changes</h2>
        <p>We will post changes here and notify account holders of material changes before they take effect.</p>
        <p className="text-sm">Last updated: 23 October 2026 (draft).</p>
      </article>
    </>
  );
}
