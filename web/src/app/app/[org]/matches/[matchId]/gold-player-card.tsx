"use client";

import { initials, RATING_ORDER, type GameRatingsView } from "./game-ratings-view";

/** Original Football Vision gold shield card. Game-style estimates, not an official game rating. */
export function GoldPlayerCard({ name, shirtNumber, teamName, photoUrl, ratings }: {
  name: string; shirtNumber: number | null; teamName: string; photoUrl: string | null; ratings: GameRatingsView;
}) {
  const by = new Map(ratings.attributes.map(a => [a.key, a]));
  return (
    <figure aria-label={`${name} game-style card, overall ${ratings.overall}`}
      className="relative mx-auto w-full max-w-[16rem] select-none text-[#3a2a06]"
      style={{ aspectRatio: "3 / 4.2" }}>
      <div className="absolute inset-0"
        style={{
          clipPath: "polygon(50% 0, 100% 7%, 100% 78%, 50% 100%, 0 78%, 0 7%)",
          background: "linear-gradient(155deg,#f7e7a6 0%,#e2bf5d 38%,#c99a2e 62%,#f0d68a 100%)",
        }} />
      <div className="absolute inset-[6px]"
        style={{ clipPath: "polygon(50% 0, 100% 7%, 100% 78%, 50% 100%, 0 78%, 0 7%)", boxShadow: "inset 0 0 0 2px rgba(90,62,8,.35)" }} />
      <div className="relative flex h-full flex-col px-[9%] pt-[11%]">
        <div className="flex items-start gap-2">
          <div className="leading-none">
            <div className="font-data text-4xl font-black">{ratings.overall}</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-wider">OVR</div>
            {shirtNumber !== null && <div className="font-data mt-2 text-sm font-bold">#{shirtNumber}</div>}
          </div>
          <div className="ml-auto aspect-square w-[58%] overflow-hidden rounded-lg border-2 border-[#8a6516]/50 bg-[#f3df9b]">
            {photoUrl ? <img src={photoUrl} alt={`Full-body AI reference photo linked to ${name}`} className="h-full w-full object-contain" />
              : <span className="flex h-full w-full items-center justify-center font-display text-3xl font-bold text-[#8a6516]" aria-hidden>{initials(name)}</span>}
          </div>
        </div>
        <figcaption className="mt-2 truncate border-b border-[#8a6516]/40 pb-1 text-center font-display text-lg font-black uppercase tracking-tight">{name}</figcaption>
        <p className="truncate text-center text-[10px] uppercase tracking-wider opacity-80">{teamName}</p>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 px-1">
          {RATING_ORDER.map(k => {
            const a = by.get(k);
            return (
              <div key={k} className="flex items-baseline gap-1.5">
                <dd className={`font-data w-6 text-right text-base font-black ${a?.baseline ? "opacity-50" : ""}`}>{a?.score ?? 50}</dd>
                <dt className="text-xs font-bold">{k}{a?.baseline && <span className="ml-0.5 text-[9px] font-normal">*</span>}</dt>
              </div>
            );
          })}
        </dl>
        <p className="mt-auto mb-[13%] text-center text-[8px] font-bold uppercase leading-tight tracking-wider">Game-style estimates<br />Football Vision</p>
      </div>
    </figure>
  );
}
