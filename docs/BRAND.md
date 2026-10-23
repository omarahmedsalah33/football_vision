# Football Vision — Brand implementation

Source: *Sports AI: Brand Identity & Visual Guidelines* (Sarah Samy, 2026-04-09), with the product
named **Football Vision** by the product owner (2026-10-23). This file records how the guide is
implemented in code and where judgement calls were made. Tokens live in
`web/src/app/globals.css`; change a colour there and the whole product follows.

## Colours (exact codes from the guide)

| Role (guide) | Name | Hex | Implementation |
|---|---|---|---|
| Website background | (guide: "Primary Color") | `#0B1F17` | `--bg` |
| Foundational | Lush Green | `#2E8B57` | `--lush`: CTA band, pitch, foundational surfaces |
| Signature | Mindaro | `#D9F67D` | `--accent`: primary buttons, highlights, primary data series |
| Accentuation | Elite Gold | `#E8B33D` | `--gold`: badges, premium tier, secondary data series |
| Secondary foundational | Forest Green | `#123528` | `--surface`: cards, panels, containers |
| Structural | Pitch Line | `#2C5C46` | `--border`: borders, dividers |
| Structural | Cascade | `#BFCEC7` | `--muted`: secondary text and meta information |
| Text | White | `#F5F7F2` | `--fg` |

Rules applied:
- Shades the guide doesn't define (hover states, panel tints) are only **mixed from guide colours**
  with `color-mix()`, never invented. The single exception is an error red (`#FF7A6B`), because
  errors must read as errors.
- Data visualisation: primary data in Mindaro, secondary data in Elite Gold (guide §3, point 8).
  Validated with the palette checker on `#0B1F17`: colour-blind separation ΔE 12.9 (target ≥ 8)
  and normal-vision ΔE 16.2 (floor 15) pass; both colours sit *above* the recommended dark-mode
  lightness band (they glare slightly on large fills). Darkening them into the band was tried
  systematically and always pushed the pair below the normal-vision floor, so we keep the exact
  brand colours, use them for lines and dots rather than large fills, and add a non-colour cue:
  Team B is always dashed.
- Lush Green is about 3.9:1 against white and 4:1 against `#0B1F17`, so only large or bold text sits
  directly on it (WCAG AA). Small text on Lush Green goes inside a dark pill.

## Typography

| Guide role | Font | Why |
|---|---|---|
| Primary (headings, display) | Barlow Condensed 600–800, italic for hero lines | Bold, condensed, architectural; reads as sport |
| Secondary (body, UI) | Inter | Highly readable at small sizes, professional |
| Special (data, numbers) | JetBrains Mono with tabular figures | Precision; numbers align in columns (`.font-data`) |

## Graphic elements

- **Logo mark**: an eye (vision) drawn as a pitch, with the halfway line, a centre-circle iris and a
  gold centre spot. Flat colours only, no effects (guide logo rules). A chalk-texture variant
  (guide P.S.) is not made yet.
- **Corner elements**: quarter-circle arcs from pitch corner markings (`CornerMarks` component),
  used on cards, the featured tier and the CTA band.
- **Pitch graphic**: the recurring motif, also the coordinate system for real analytics (105 × 68 m).
- **AI iconography**: minimal geometric line icons (nodes, frames, tracks).

## Voice

Conversational, confident, plain language; speak directly to coaches, players and clubs.
Accessible, never cheap. Egypt-first ("Built in Egypt", prices in Egyptian pounds at launch).

## Deliberate deviations (integrity value)

1. **No "real-time" claims.** The guide describes "real-time intelligence"; the product analyses
   uploaded footage after the match. Live analysis would be a different product (live streams and
   on-site GPUs). Not claimed until true.
2. **No stock photography.** The guide requires authentic photos with warm grading. None exist yet,
   so the site uses pitch and data graphics. Needed: real match, training and sideline photos with
   consent from those pictured (including guardians of minors).
3. **"Validated, accurate data"** is described as a method, not a result, until the SoccerTrack v2
   evaluation produces measured accuracy figures.
4. Tagline used as given: *Train. Measure. Perform. Discover.* Brand promise adapted to
   "Professional-grade analysis. For every team." while capabilities are still being built.

## Open items

- Real photography (see above) and a decision on the chalk-texture logo variant.
- Arabic / RTL version of the site (strongly implied by "Egypt-first").
- Logo files for print and social (SVG master, mono version, clear-space spec).
