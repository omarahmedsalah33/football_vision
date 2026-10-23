import type { Metadata } from "next";
import { PageHero } from "@/components/marketing/site-chrome";
import { ContactForm } from "./contact-form";

export const metadata: Metadata = {
  title: "Contact",
  description: "Talk to the Football Vision team about plans, your club, partnerships or a privacy request.",
};

export default function ContactPage() {
  return (
    <>
      <PageHero eyebrow="Contact" title={<>Let&apos;s <span className="text-mindaro">talk football</span></>}>
        Questions about plans, a demo for your academy, or a privacy request: send us a message and a real
        person will reply.
      </PageHero>
      <section className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-6 text-muted">
          <div>
            <h2 className="font-display text-2xl font-bold uppercase text-fg">Clubs & academies</h2>
            <p className="mt-2">Tell us how many teams you run and how you film matches today. We&apos;ll suggest a setup.</p>
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold uppercase text-fg">Privacy requests</h2>
            <p className="mt-2">
              To access, correct or delete your data, choose “Privacy or data request”. Signed-in users can also
              delete their account from their account settings.
            </p>
          </div>
        </div>
        <ContactForm />
      </section>
    </>
  );
}
