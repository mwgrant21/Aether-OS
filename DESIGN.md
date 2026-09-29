---
name: Aether OS
description: A personal mission-control cockpit for Claude Code, lit from within by a live storm reactor.
colors:
  accent-cyan: "#7ef0ff"
  accent-cyan-deep: "#17b8d8"
  accent-cyan-soft: "#7fd8ef"
  success: "#3be0a0"
  warn: "#f5c66b"
  warn-deep: "#d9a13f"
  danger: "#ff6b7a"
  danger-soft: "#ff9d9d"
  bg-base: "#020a10"
  bg-terminal: "#06141c"
  page-radial-core: "#0a2634"
  page-radial-mid: "#04121a"
  panel-top: "rgba(9,28,38,.8)"
  panel-bottom: "rgba(6,18,26,.8)"
  panel-inset: "rgba(6,20,28,.7)"
  panel-border: "rgba(70,180,215,.24)"
  chrome-bg: "rgba(4,16,24,.6)"
  chrome-border: "rgba(70,180,215,.16)"
  chip-border: "rgba(80,190,220,.25)"
  active-border: "rgba(95,220,255,.4)"
  ink-on-cyan: "#04202b"
  ink-on-amber: "#1a1204"
  text-primary: "#eafcff"
  text-body: "#d8f6ff"
  text-secondary: "#9fc4d1"
  text-muted: "#5f8a97"
  text-dim: "#568898"
typography:
  wordmark:
    fontFamily: "Rajdhani, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "6px"
  title:
    fontFamily: "Rajdhani, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1
  nav:
    fontFamily: "Rajdhani, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1
  panel-heading:
    fontFamily: "Rajdhani, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "3px"
  body:
    fontFamily: "Rajdhani, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Rajdhani, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "2px"
  readout-xl:
    fontFamily: "'Space Mono', monospace"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.1
  readout:
    fontFamily: "'Space Mono', monospace"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1
  data:
    fontFamily: "'Space Mono', monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1
rounded:
  chip: "7px"
  tile: "9px"
  panel: "14px"
  pill: "30px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent-cyan}"
    textColor: "{colors.ink-on-cyan}"
    typography: "{typography.panel-heading}"
    rounded: "{rounded.tile}"
  button-primary-disabled:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.text-dim}"
    typography: "{typography.panel-heading}"
    rounded: "{rounded.tile}"
  button-secondary:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.accent-cyan}"
    typography: "{typography.panel-heading}"
    rounded: "{rounded.tile}"
  nav-item:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.nav}"
    rounded: "{rounded.tile}"
  nav-item-active:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.text-primary}"
    typography: "{typography.nav}"
    rounded: "{rounded.tile}"
  chip-quiet:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
  panel:
    backgroundColor: "{colors.panel-top}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.panel}"
    padding: "20px"
  terminal:
    backgroundColor: "{colors.bg-terminal}"
    textColor: "{colors.text-body}"
    typography: "{typography.data}"
---

# Design System: Aether OS

## Overview

**Creative North Star: "The Reactor Console"**

Aether OS is a control room built around a live core. The storm reactor sits at the centre of the dashboard as an instrument, not an illustration: its brightness, discharge rate and hue report what Claude Code is doing right now. Everything else is framed around it. Panels are translucent teal glass floating over a deep radial glow, and light in this system is always *energy*: a control glows because it is live, a number glows because it is moving, the core glows because work is happening.

The density is high and deliberate, closer to a flight deck than a web app. Labels are small, tracked-out Rajdhani capitals; every number is set in Space Mono, so readouts line up and feel measured. The interface is dark by definition, since the reactor's light only reads against the dark.

The system rejects flat, bordered-grey "admin dashboard" chrome and decorative glow that carries no meaning. It is vivid where the reactor and live state are, and disciplined everywhere else.

**Key Characteristics:**
- One signature: the StormCore reactor, a living, procedurally animated instrument at the centre.
- Cyan light means live or active; amber means it needs the operator; red means something failed.
- Translucent gradient panels over a radial page glow; depth comes from light, not drop shadows.
- Tactile, lit controls: primary actions are filled cyan and answer touch with more light.
- Rajdhani for words, Space Mono for every number.
- Dark-only, as an invariant.

## Colors

A single cyan energy hue in three strengths, over a deep teal-black, with amber and red held back for states that need the operator.

### Primary
- **Reactor Cyan** (accent-cyan): The energy colour. Active mode pills, the lit edge of the primary button gradient, live readouts, the reactor's discharge. If it is cyan, it is live.
- **Deep Current** (accent-cyan-deep): The lower stop of the primary button gradient and progress fills; the "weight" under Reactor Cyan.
- **Soft Signal** (accent-cyan-soft): Links, secondary readouts, and agent hue accents; cyan at conversational volume.

### Secondary
- **Needs-You Amber** (warn / warn-deep): Pending approvals, stale data, depletion warnings, and the reactor's anomaly flicker. Amber is a request for the operator's attention and nothing else. Warn is the upper stop of the amber pill gradient (the AUTO mode pill) and warn-deep (`#d9a13f`) the lower.
- **Nominal Green** (success): System-healthy states: NOMINAL, ONLINE, ALL GOOD, budget remaining.

### Tertiary
- **Breach Red** (danger / danger-soft): Failures, errors and invalid input. Soft red carries error text; full red carries borders and marks.

### Neutral
- **Abyss** (bg-base): The page floor and the colour the page glow fades to.
- **Page glow** (page-radial-core → page-radial-mid → bg-base): The radial wash behind everything, centred high and to the right (`radial-gradient(1400px 900px at 60% -10%, …)`).
- **Teal Glass** (panel-top → panel-bottom): The 180° gradient of every panel; translucent, so the page glow reads through it.
- **Inset** (panel-inset): Quiet chips, inactive nav items, secondary buttons, and input fields: surfaces set *into* a panel.
- **Hairlines** (panel-border, chrome-border, chip-border): Panel edges, top bar and sidebar dividers, and chip outlines, from strongest to faintest.
- **Active Edge** (active-border): The border of anything hovered or active, and also the colour of its glow.
- **Ink on Cyan** (ink-on-cyan): Text on filled cyan buttons. **Ink on Amber** (ink-on-amber, `#1a1204`) is its counterpart for filled amber: the AUTO pill and the approvals badge.
- **Text ladder** (text-primary → text-body → text-secondary → text-muted → text-dim): Headlines and values, body, labels, meta, and disabled, in that order.

### Named Rules
**The Light Is Energy Rule.** Glow is state, never decoration. An element glows because it is live, active, hovered or focused; a static element never glows.

**The Amber Means You Rule.** Amber appears only where the operator is needed (an approval, a stale value, an anomaly). It is never used for emphasis or decoration.

**The Signal-Not-Theme Rule.** The reactor, the orchestration grid and their hue shifts are signals driven by live state (burn rate, alarm level, overload). They are deliberately excluded from theming and never recoloured for aesthetics.

## Typography

**UI Font:** Rajdhani (with sans-serif), bundled via `@fontsource/rajdhani` at 400, 500, 600 and 700
**Data Font:** Space Mono (with monospace), bundled via `@fontsource/space-mono` at 400

**Character:** Rajdhani's narrow, squared geometry reads like instrument lettering, especially tracked out in capitals. Space Mono gives every figure a fixed width, so columns of numbers line up and ticking values don't jitter.

### Hierarchy
- **Wordmark** (700, 20px, 6px tracking): The AETHER OS mark in the top bar only.
- **Title** (700, 18px): The name at the top of a detail card (agent, project).
- **Nav** (600, 14px): Sidebar navigation items.
- **Panel heading** (600, 12px, 3px tracking, uppercase): Every panel's title (REACTOR STATUS, RECENT ALERTS). Also the button label style.
- **Body** (400, 12px, 1.5 line height): Descriptions and explanatory copy.
- **Label** (600, 11px, 2px tracking, uppercase): Stat captions and chip text. 11px is the floor for all functional text.
- **Readout XL** (Space Mono 700, 32px): The one headline figure in a card (session cost).
- **Readout** (Space Mono 700, 22px): Stat values in the bottom metrics row.
- **Data** (Space Mono 400, 11px): Timestamps, IDs, table values, and the log.

### Named Rules
**The Numbers Are Mono Rule.** Every number the operator reads (tokens, dollars, percentages, times, counts) is set in Space Mono. Words are Rajdhani.

**The Caps Are Labels Rule.** Tracked-out capitals are for labels, headings and button text: short, scannable taxonomy. Sentences stay in sentence case.

## Layout

The app is a **fixed 1536×1024 design canvas** that scales uniformly to fit the window (`useViewportScale.ts` / `frameScale.ts`); it does not reflow. Every layout is designed at that one size.

The frame is a top bar (wordmark, mode pills, approvals, operator), a left sidebar (navigation, recent agents, a reactor miniature), a main area, and a thin status footer. The dashboard's main area is two columns. REACTOR STATUS fills the left half. The right half is READINESS on top, then a panel for each digest that has data (ACTIVE AGENTS, PROJECTS, RECENT ALERTS), then the STANDBY STRIP, which lists the digests that don't. At a cold STANDBY the right half is just READINESS and the strip, so an idle console draws no empty boxes, and a live console with no alerts shows no empty alerts panel. A row of metric cards runs along the bottom.

Spacing uses a 4px-based scale (xs 4, sm 8, md 12, lg 16, xl 24). Panels sit 16px apart; panel padding is around 20px.

## Elevation & Depth

Aether OS is **light-lit, not shadow-lifted.** Depth comes from layering: translucent gradient panels float over the radial page glow, and inset surfaces sit darker within them. There are no ambient drop shadows on resting surfaces. The one large dark shadow (`0 20px 60px rgba(0,0,0,.6)`) is reserved for overlays and modals that lift above the whole frame.

### Shadow Vocabulary
Implemented as the `glows` token group in `src/styles/tokens.ts` (`active`, `hot`, `needsYou`, `innerCharge`, `primaryHover`, `overlayLift`); use the token, not the literal.

- **Active glow** (`0 0 10px rgba(95,220,255,.4)`): An active mode pill, the selected nav item, a lit control.
- **Hot glow** (`0 0 8px rgba(95,240,255,.8)`): Small live indicators and dots.
- **Needs-you glow** (`0 0 12px rgba(245,198,107,.45)`): An amber control that is waiting on the operator.
- **Inner charge** (`inset 0 0 14px rgba(95,240,255,.12)`): A lit surface that glows from inside, such as a hovered secondary button.
- **Overlay lift** (`0 20px 60px rgba(0,0,0,.6)`): Modals and floating panels only.

### Named Rules
**The Glow-Is-State Rule.** A surface is flat at rest. Glow appears only in response to state: active, hovered, focused, live, or needing the operator.

## Shapes

Softly squared, never pill-by-default. Panels are rounded at 14px, tiles and buttons at 9px, chips at 7px, and full pills (30px) are reserved for the operator badge and capsule toggles. Circles are for live things: the reactor, status dots, avatars. Every edge is a 1px hairline from the cyan-tinted border set; nothing uses grey.

## Components

### Buttons
Tactile and lit: buttons feel like switches that light up under your finger.
- **Shape:** Gently squared (tile radius, 9px).
- **Primary:** A vertical cyan gradient (`linear-gradient(180deg, #7ef0ff, #17b8d8)`) with Ink on Cyan text in the panel-heading style (tracked caps), resting with the active glow. The exception is OPEN TERMINAL, the Dashboard's only primary: per Glow-Is-State it rests flat at STANDBY.
- **Hover:** Brighter gradient, a stronger glow (around 0 0 24px at .65), and a 1px lift.
- **Pressed:** The gradient darkens toward Deep Current and an inset shadow sinks the button.
- **Keyboard focus:** A 2px Text Primary outline offset 3px, on top of whatever glow the state already has, and keyboard focus also applies the same lit treatment as hover. The ring shows for keyboard focus only (gated on `:focus-visible`), never on a mouse click. Every interactive element gets it.
- **Disabled:** Inset background, Text Dim label, no glow.
- **Secondary:** Inset background, Reactor Cyan text, Active Edge border; on hover the border goes solid cyan and gains an outer and inner glow.
- **Needs-you (amber):** A solid Needs-You Amber fill with Ink on Amber text and the needs-you glow, used only for approve/review actions. The AUTO mode pill is the segmented-control form: a warn to warn-deep gradient, Ink on Amber text, and the needs-you glow, from one shared `opModeOnSkin` (`src/components/shared/opModes.ts`).
- **Motion:** Bars and arcs that report a changing reading settle on `motion.easing.decelerate` (`cubic-bezier(0.16, 1, 0.3, 1)`), an exponential ease-out, so a value arrives instead of sliding at constant speed.
- **Implementation:** Always the `Button` primitive (`src/components/shared/Button.tsx`), never a clickable `div`/`span`; hover comes from `useHoverStyle()`.

### Mode Pills
A segmented control (PLAN / EDITS / AUTO) inside an inset tray with a chip border. The active segment takes the primary gradient and active glow, except AUTO, which takes the needs-you amber fill and glow because it auto-approves; inactive segments are Text Muted on nothing.

### Empty States
The shared `EmptyState` (`src/components/shared/EmptyState.tsx`) is the one voice for a view or panel with nothing to show: a single plain sentence in Rajdhani 12px Text Muted, sentence case, saying what will appear and where it comes from, and at most one secondary action (the Secondary button treatment). It is flat at rest; only the action lights, on hover or keyboard focus. When it holds an action, its root reserves 6px on every side so the 5px focus ring is never clipped by an `overflow: auto` list; a message-only empty state takes no padding, so its sentence aligns with the panel heading. On the Dashboard a digest with nothing to show is not drawn as an empty panel at all (apart from its brief fade-out): it becomes an item in the STANDBY STRIP. OPEN TERMINAL, under READINESS, is the Dashboard's only primary action; the reactor card has no actions.

### Readiness and Standby Strip
The idle dashboard's right column (`src/components/dashboard/`).
- **READINESS** (`ReadinessCard.tsx`): an `h2` and a list of four rows, each a status dot and one plain sentence: Desktop app, Terminal, Statusline, Collector (copy in `readinessMath.ts`). A met row's dot is filled Nominal Green; only the live signals (Terminal, Statusline) glow, and only while a session is live, so a met row at STANDBY is flat green. Desktop app and Collector are static facts and never glow. An unmet row is a hollow Text Muted ring. **No amber:** none of these asks the operator for anything. OPEN TERMINAL sits under the list.
- **OPEN TERMINAL** (`OpenTerminalButton.tsx`): the primary button. In browser mode it stays in place, `aria-disabled` (still focusable) in the disabled treatment, with the Desktop-app reason directly beneath it in Rajdhani 12px Text Muted, so it reads as unavailable, not broken. Per Glow-Is-State it rests flat and glows only while a session is live, or on hover or keyboard focus.
- **STANDBY STRIP** (`StandbyStrip.tsx`): one thin panel with a visually hidden `h2`. It holds one quiet `Button` (no underline) per digest without data, then `Memory N engrams`, separated by `·` in Space Mono Text Dim. Labels are Rajdhani Text Secondary; counts are Space Mono Soft Signal. Each item opens its view (the alerts item opens the notifications dropdown). It is hidden once every digest has a panel.
- **Digest arrival** (`DigestSlot.tsx`): a digest that gains data rises in on opacity and an 8px `translateY` over `motion.duration.slow` with `motion.easing.decelerate`; one that loses data fades the same way, then unmounts. Height is never animated (the column reflows at once), and under reduced motion it appears and disappears without animation.

### Chips
- **Quiet chip:** Inset background with a chip border, the established pair for inactive tabs, small overlays and persistent badges.
- **Status tags:** Small Space Mono capitals (STALE, NOMINAL) in the state colour with a matching translucent border.

### Cards / Containers
- **Corner Style:** Panel radius (14px).
- **Background:** Teal Glass gradient (`linear-gradient(180deg, rgba(9,28,38,.8), rgba(6,18,26,.8))`).
- **Border:** 1px panel border. An alerting card may swap to an amber border.
- **Heading:** Panel heading style in Text Secondary, top left; an optional action link ("VIEW ALL →") top right in Soft Signal.
- **Internal Padding:** Around 20px.

### Inputs / Fields
- **Style:** Inset background, 1px chip border, tile radius, Space Mono text.
- **Hover:** The border rises to Active Edge.
- **Focus:** The border goes solid Reactor Cyan with a 3px translucent cyan ring and a soft glow.
- **Error:** A Breach Red border and soft glow, with a Soft Red message in the data style below.

### Navigation
Boxed sidebar items: an inset background, a 1px chrome border, and a small square indicator dot. The active item takes a cyan-tinted fill, an Active Edge border, the active glow, and a lit cyan dot. Hover brightens the item and raises its border.

### Terminal
The embedded xterm.js terminal sits on its own darker surface (bg-terminal) in Space Mono. It keeps its theme in sync reactively, because the terminal instance is a module-level singleton outside React's render cycle.

### Storm Core (signature component)
The heart of the product and its most distinctive element. A 268px (native) instrument that is scaled only by a wrapper transform, since its internal geometry is pinned. It is built from layered CSS and a procedural canvas:
- A **60-tick containment ring** (every fifth tick long) turning slowly, plus **broken LCARS arc rings** cut from conic gradients and counter-rotating.
- A **radial plasma sphere** that breathes on the shared reactor pulse (`--pulse-dur`, 2.4s by default), wrapped in a swirl of blurred plasma, filaments, and a hue-drifting nebula.
- A **procedural discharge layer** (`aetherStorm.ts`): lightning crawls the plasma surface and jumps to the containment ring. The discharge rate and branching follow the reactor mode (idle, nominal, surge, breach), and it **fires a burst whenever the live agent count rises**.
- A **hue-rotate filter** computed from theme, alarm level and overload, applied on the component's own isolated root so the blend layers never bleed past its circle.
- A shared **amber anomaly flicker** whenever anomalies are present, independent of the budget-driven alarm level.

Under reduced motion the reactor keeps breathing at a calm, steady rate rather than freezing, because a frozen reactor reads as broken.

**Placement.** Storm Core is the dashboard's centrepiece: it fills the REACTOR STATUS panel, which takes the left half of the dashboard's main area; the reactor itself stays 360px, scaled by its wrapper only. `storm` is the default renderer for new profiles (the Settings renderer choice still wins once saved). The sidebar miniature shows the reactor on every other view and is replaced by an empty, same-size placeholder on the Dashboard, so only one reactor animates at a time.

**Standby: dark and cold.** When no Claude session is live (`isSessionLive` in `dashboardMath.ts`: a positive burn rate, an open dispatch while the terminal is alive, a fresh statusline, or a busy fleet session), the console goes to STANDBY:
- The reactor dims through its own filter (brightness .45, saturate .35), fading over `motion.duration.slow`, and powers up visibly when a session starts.
- Status text reads STANDBY in Text Muted, never cyan, in both the panel and the footer, and both status dots are flat until a session is live or an alarm is up (`statusDotGlows`).
- The line under the reactor reads exactly `— tok/min · standby`; the Terminal view's prompt line reads `standby` instead of `session active`.
- Readouts with no real source show `—`, never a simulated number or a zero. The KPI tiles are MONTH TOKENS, DEPLETION ETA, TODAY and BUDGET LEFT; TODAY is today's cost at API rates (`API rate, not paid`), exact (no `~`), and `—` when no priced activity was observed, when there is no ledger snapshot yet, or when the snapshot is from an earlier local day; a real zero day shows `$0.00`.

Only the storm renderer dims; the classic renderer keeps its per-frame filter.

**The Living Core Rule.** Storm Core is the one place Aether is allowed to be spectacular. Everything around it stays disciplined so it stays the brightest, most alive thing on screen. Never place competing animated or glowing art near it, never recolour it for aesthetics, and never redesign it as part of a polish pass.

## Do's and Don'ts

### Do:
- **Do** read colours through `useColors()` and pass `colors: ColorPalette` into style functions; never import the static palette into a themed component.
- **Do** use the `Button` primitive and `useHoverStyle()` for every interactive element.
- **Do** give every interactive element the keyboard focus ring (2px Text Primary outline, 3px offset).
- **Do** set every number in Space Mono, and every label and heading in tracked Rajdhani capitals.
- **Do** mark an estimated figure with a `~` and name its basis; never mark an exact one. Render "no data" differently from zero.
- **Do** keep Storm Core as the brightest, most animated element on the dashboard.
- **Do** keep uninterrupted rotation and flow (spin, conduit flow, dash flow, scan) on linear easing.

### Don't:
- **Don't** add a light theme. Aether OS is dark-only by rule; a light mode would be a redesign, not a variant.
- **Don't** add glow to anything that isn't live, active, hovered, focused or waiting on the operator.
- **Don't** use amber for emphasis or decoration.
- **Don't** theme or recolour the reactor or the orchestration grid; their colour is data.
- **Don't** set `outline: none` without replacing it with a visible focus treatment.
- **Don't** retype token values as literals (`#7ef0ff`, `rgba(95,220,255,.4)`); use the token.
- **Don't** use grey borders or grey surfaces; every neutral here is tinted teal.

## Known Gaps

States and rules this document describes but the code does not yet fully meet, or that nobody has designed. Updated 2026-09-29 after polish passes 1 and 2 and the idle composition. Closed by those passes: keyboard focus, landmarks and headings, the 11px type floor, Text Dim contrast (now 5.1:1 on Abyss, 4.6:1 on panels), the reactor's placement, and honest idle readouts. Screen-reader state also closed: `aria-pressed` on the operating-mode pills and the usage-range chips, `aria-current` on the active nav item, the reactor exposed as `role="img"` with a state label, and a screen-reader-only `h1` per view. The idle composition closed the idle dashboard's empty digest panels (now READINESS and the STANDBY STRIP), the contradictory standby signals (rate line, footer dot, Terminal header), and the stray `#8ab6ff` in alert colours.

- **Token adoption is partial.** About 364 hardcoded colour literals across 47 files duplicate palette values (32 of them in shell chrome per the 2026-09-28 detector run); `radii` is used at 0 call sites and `space` at 3. Radii of 8px and 6px are widely used (32 and 22 sites) but are not tokens: either add them to `radii` or move those sites onto the existing steps.
- **Motion is only partly curved.** `motion.easing.decelerate` now exists and drives bars and arcs, but `standard` and `emphasis` are still the browser defaults (`ease`, `ease-in-out`); the tactile hover, press and glow transitions need designed curves.
- **Pressed state.** The pressed treatment above is chosen but still unimplemented in `Button` or `useHoverStyle`, which handle hover and keyboard focus only.
- **Loading and error states.** Empty states are done through the shared `EmptyState` for the dashboard, agents, analytics, projects, terminal, files, comms and the top-bar dropdowns. Loading and error states are still handled ad hoc per view.
- **Settings toggles lack pressed state.** The ON/OFF switches and the permission, narration and density segmented buttons in Settings don't expose `aria-pressed` yet; only the operating-mode pills and usage-range chips do.
- **Grid keyboard access.** The orchestration grid's SVG agent nodes (`<g onClick>`) can't be reached by keyboard.
- **Known clipping.** The sidebar's RECENT AGENTS label is half-clipped by the reactor miniature, and the Settings left column is clipped under the bottom metrics row. Both predate the polish passes.
- **Percentages are not verified clamped in live mode.** A 2026-08-10 screenshot showed the context ring at "663% USED". Browser mode now shows "—", but the live Electron path hasn't been checked since.
- **No command palette.** The retired SYSTEMS card advertised "CTRL+K jumps anywhere", but no palette or shortcut exists in the code (no key handler, no Electron accelerator). The hint was removed rather than moved to the top bar. A palette needs its own spec before a keycap chip can point at it.
- **Existing profiles keep their saved renderer.** `storm` is only the default for new profiles; a profile that saved `classic` keeps it until changed in Settings.
