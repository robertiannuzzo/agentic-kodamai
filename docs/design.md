# Interface design

The console follows [kodamai.com](https://www.kodamai.com) so the product and the company read as one thing.

## Decisions

| Element | Choice | Why |
|---|---|---|
| Theme | Dark first (`#050507` canvas, graphite surfaces), with a light theme in display settings | Matches the site; light is there for bright rooms and printing |
| Accent | Emerald, used only for what is verified: completed chain steps, evidence, the hire | The site's line is "your agents, verified"; one accent keeps its meaning |
| Primary action | White pill; everything else is an outlined ghost pill | Mirrors the site's "Request a demo" button |
| Type | Outfit Light for headings, Inter for text, Space Grotesk in small uppercase for labels, IDs and evidence | The site's three families; the label face makes references and evidence feel like records |
| Fonts | Bundled with the app (Fontsource), not loaded from Google | The app's content security policy allows only its own origin, and it avoids sending candidates' IP addresses to a third party |
| Status colours | Amber waiting, orange changes requested, rose declined or rejected, sky advertising or shortlisted, emerald approved, filled or hired | One meaning per colour, used the same way in the sidebar, header, rail and applicant list |

## Structure

- **Stage rail.** Every requisition shows the typed chain: raised → approved → advert frozen → applications → hired. Each step shows who completed it or what is waiting. It is the `Seq` composition in the Idris kernel, drawn.
- **Tabs, not one long page.** Requisition, Advert, Applicants and People. Each role opens where its next action is.
- **Evidence rail.** The audit trail sits beside the work in plain sentences, with a toggle for the raw evidence strings the kernel checks.
- **Applicant detail as a slide-over.** Rows stay scannable (score bar on a shared scale, total out of the maximum, decision chip); review, hire and erasure happen in the panel.
- **Demo controls are labelled as demo.** The persona switch reads "Demo as", and currency and theme live in a small settings menu.
- **Stage labels come from one function** (`displayStage`), so the sidebar and the page can no longer disagree.
