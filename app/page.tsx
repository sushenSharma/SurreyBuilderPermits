import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  FileUp,
  ShieldCheck
} from "lucide-react";
import Link from "next/link";

const landingSteps = [
  {
    title: "Upload the plan set",
    text: "Drop in the permit PDF your designer or draftsperson prepared.",
    icon: FileUp
  },
  {
    title: "Sheets are prepared",
    text: "The plan set is split into reviewable pages and kept organized.",
    icon: FileSearch
  },
  {
    title: "Get a clear action list",
    text: "See likely BCBC issues, missing information, and items to confirm.",
    icon: ClipboardCheck
  }
];

const landingChecks = [
  "Room sizes and missing dimensions",
  "Door and window tag issues",
  "Stairs, guards, handrails, and landings",
  "Items that need designer clarification"
];

export default function LandingPage() {
  return (
    <main className="landingShell">
      <header className="landingNav">
        <Link className="landingBrand" href="/">
          <span>
            <ShieldCheck size={22} />
          </span>
          <div>
            <strong>Builder Precheck</strong>
            <small>BCBC 2024 support</small>
          </div>
        </Link>
        <nav>
          <a href="#how-it-works">How it works</a>
          <a href="#checks">What it checks</a>
          <Link className="landingNavButton" href="/review">
            Start review
          </Link>
        </nav>
      </header>

      <section className="landingHero">
        <div className="landingHeroCopy">
          <p className="eyebrow">Permit plan precheck for builders</p>
          <h1>Catch permit issues before the city reviewer does.</h1>
          <p>
            Upload a permit plan set and get a plain-language BCBC precheck report that shows what to fix, what to
            confirm, and what information is missing before submission.
          </p>
          <div className="landingActions">
            <Link className="landingPrimary" href="/review">
              Start plan check
              <ArrowRight size={18} />
            </Link>
            <a className="landingSecondary" href="#how-it-works">
              See how it works
            </a>
          </div>
          <div className="landingTrust">
            <span>
              <CheckCircle2 size={16} />
              One PDF in
            </span>
            <span>
              <CheckCircle2 size={16} />
              Sheet-by-sheet review
            </span>
            <span>
              <CheckCircle2 size={16} />
              Actionable report out
            </span>
          </div>
        </div>

        <div className="landingPreview" aria-label="Precheck report preview">
          <div className="previewToolbar">
            <span>BCBC precheck preview</span>
            <strong>Ready</strong>
          </div>
          <div className="previewDrop">
            <FileUp size={34} />
            <strong>12627 ARCH APRIL 20.pdf</strong>
            <span>Plan set queued for review</span>
          </div>
          <div className="previewStats">
            <div>
              <strong>11</strong>
              <span>sheets</span>
            </div>
            <div>
              <strong>9</strong>
              <span>fix</span>
            </div>
            <div>
              <strong>18</strong>
              <span>confirm</span>
            </div>
          </div>
          <div className="previewIssue">
            <span>Likely city comment</span>
            <strong>Door size needs confirmation</strong>
            <p>Show door schedule or revise tag so width and height can be verified.</p>
          </div>
        </div>
      </section>

      <section className="landingSection" id="how-it-works">
        <div className="landingSectionHeader">
          <p className="eyebrow">How it works</p>
          <h2>Built for the way builders actually review drawings.</h2>
        </div>
        <div className="landingStepGrid">
          {landingSteps.map((step, index) => {
            const Icon = step.icon;
            return (
              <article key={step.title}>
                <span>{index + 1}</span>
                <Icon size={24} />
                <strong>{step.title}</strong>
                <p>{step.text}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="landingSplit" id="checks">
        <div>
          <p className="eyebrow">What builders see</p>
          <h2>No raw code dump. Just the next action.</h2>
          <p>
            Failed checks open into builder-readable details: the code reference, what the plan appears to show, and the
            correction or clarification needed before city review.
          </p>
          <Link className="landingPrimary compactLandingButton" href="/review">
            Open review tool
            <ArrowRight size={18} />
          </Link>
        </div>
        <div className="landingChecklist">
          {landingChecks.map((check) => (
            <div key={check}>
              <CheckCircle2 size={18} />
              <span>{check}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="landingFooter">
        <span>Builder Precheck</span>
        <span>Use as a pre-submission check, not a permit approval.</span>
      </footer>
    </main>
  );
}
