"use client";

import {
  Building2,
  CheckCircle2,
  FileText,
  Layers3,
  LogOut,
  Loader2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { DragEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "../../lib/supabase/client";
import { isSupabaseConfigured } from "../../lib/supabase/config";

type Sheet = {
  id: string;
  title: string;
  range: string;
  confidence: number;
  status: "ready" | "warning" | "review";
  notes: string;
};

type AgentStep = {
  name: string;
  state: "idle" | "running" | "done";
};

type ExtractedSheet = {
  sheet_id: string;
  title: string;
  extraction_confidence: number;
  units: unknown[];
  door_tags_found: string[];
  window_tags_found: string[];
  structural_notes: string[];
  annotations: string[];
  completeness_check?: {
    completeness_pct: number;
    extracted_dimension_strings: number;
    expected_dimension_strings: number;
  };
  low_confidence_items?: string[];
};

type DimensionFinding = {
  check_id: string;
  bcbc_clause: string;
  bcbc_table: string | null;
  element: string;
  sheet: string;
  building: string;
  unit: string;
  extracted_value: string;
  required_value: string;
  status: "PASS" | "VERIFY" | "FLAG";
  note: string;
  downstream: string | null;
};

type DimensionStatusFilter = "ALL" | DimensionFinding["status"];

type RoomMeasurement = {
  sheet_id: string;
  sheet_title: string;
  sheet_type: string;
  room_name: string;
  dimensions: string | null;
  area: string | null;
  door_tags: string[];
  window_tags: string[];
  notes: string;
  source: string;
};

type OpeningTag = {
  sheet_id: string;
  sheet_title: string;
  sheet_type: string;
  room_name: string;
  tag: string;
  kind: "door" | "window";
  decoded_size: string | null;
  width_mm: number | null;
  height_mm: number | null;
  egress_status: "PASS" | "VERIFY" | "FLAG";
  egress_note: string;
  source: string;
};

type PageReview = {
  page: number;
  review: {
    page: number;
    sheet: string;
    title: string;
    drawingType: string;
    floorLevel: string;
    occupancyAssumption: string;
    overallResult: "APPROVED" | "REVISIONS REQUIRED" | "INCOMPLETE SUBMISSION";
    summary: string;
    counts: {
      pass: number;
      fail: number;
      cannotDetermine: number;
    };
    checks: Array<{
      category: string;
      codeReference: string;
      requirement: string;
      observation: string;
      verdict: "PASS" | "FAIL" | "CANNOT DETERMINE";
      requiredCorrection: string;
    }>;
    deficiencies: Array<{
      codeReference: string;
      requirement: string;
      observedCondition: string;
      requiredCorrection: string;
    }>;
    notDetermined: Array<{
      item: string;
      neededInformation: string;
    }>;
  };
};

type SplitterResult = {
  summary: {
    sheetCount: number;
    needsReview: number;
    notes: string;
  };
  sheets: Sheet[];
  handoff?: {
    visionExtractor: string[];
    textExtractor: string[];
    crossSheetRisks: string[];
  };
  extraction?: {
    summary: {
      extractedSheets: number;
      notes: string;
    };
    sheets: ExtractedSheet[];
  };
  artifacts?: {
    relativeRunDir: string;
    runDir: string;
  };
  precheck?: {
    summary: {
      blockerCount: number;
      warningCount: number;
      infoCount: number;
      clarificationCount?: number;
      notes: string;
    };
    issues: Array<{
      severity: "blocker" | "warning" | "info" | "needs_clarification";
      sheet_id: string;
      category: string;
      issue: string;
      source?: string;
      evidence?: string;
      recommended_action: string;
      official_source_url?: string;
    }>;
  };
  dimensions?: {
    summary: {
      passCount: number;
      verifyCount: number;
      flagCount: number;
      notes: string;
    };
    findings: DimensionFinding[];
  };
  roomMeasurements?: {
    summary: {
      roomCount: number;
      dimensionedRoomCount: number;
      notes: string;
    };
    rooms: RoomMeasurement[];
  };
  openings?: {
    summary: {
      tagCount: number;
      doorCount: number;
      windowCount: number;
      passCount: number;
      verifyCount: number;
      flagCount: number;
      notes: string;
    };
    tags: OpeningTag[];
  };
  remotePages?: Array<{
    page: number;
    url: string;
    bucket?: string;
    key?: string;
    s3Url?: string;
    mediaType?: string;
    size?: number;
  }>;
  job?: {
    jobId: string;
    status: "queued" | "running" | "complete" | "error";
    currentPage: number | null;
    completedPages: number;
    totalPages: number;
    error?: string;
    pages: Array<{
      page: number;
      status: "pending" | "running" | "done" | "error";
      error?: string;
    }>;
  };
  pageReviews?: PageReview[];
};

const defaultSteps: AgentStep[] = [
  { name: "Upload plans", state: "idle" },
  { name: "Split sheets", state: "idle" },
  { name: "Save pages", state: "idle" },
  { name: "Read drawings", state: "idle" },
  { name: "Check BCBC", state: "idle" },
  { name: "Build report", state: "idle" }
];

const stepDescriptions = [
  "Gets your permit PDF ready.",
  "Separates the plan set into individual sheets.",
  "Keeps each sheet available while the review runs.",
  "Looks for rooms, stairs, doors, windows, notes, and dimensions.",
  "Compares visible plan information with BCBC 2024 checks.",
  "Turns the findings into a builder-friendly action list."
];

const builderPromise = [
  "No manual sheet sorting",
  "Checks every page it can read",
  "Clear fix-or-confirm report"
];

const pdfLambdaUrl = process.env.NEXT_PUBLIC_PDF_LAMBDA_URL ?? "";

export default function Home() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runningAction, setRunningAction] = useState("");
  const [result, setResult] = useState<SplitterResult | null>(null);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [dimensionStatusFilter, setDimensionStatusFilter] = useState<DimensionStatusFilter>("FLAG");
  const [dimensionSheetFilter, setDimensionSheetFilter] = useState("ALL");
  const [expandedFailPage, setExpandedFailPage] = useState<number | null>(null);
  const [steps, setSteps] = useState(defaultSteps);
  const supabase = useMemo(() => (isSupabaseConfigured() ? createClient() : null), []);
  const [userEmail, setUserEmail] = useState("");

  const fileSize = useMemo(() => {
    if (!file) return "";
    const mb = file.size / 1024 / 1024;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  }, [file]);

  const dimensionSheets = useMemo(() => {
    const sheets = new Set(result?.dimensions?.findings.map((finding) => finding.sheet) ?? []);
    return Array.from(sheets).sort((first, second) => first.localeCompare(second, undefined, { numeric: true }));
  }, [result?.dimensions?.findings]);

  const filteredDimensionFindings = useMemo(() => {
    const findings = result?.dimensions?.findings ?? [];

    return findings.filter((finding) => {
      const matchesStatus = dimensionStatusFilter === "ALL" || finding.status === dimensionStatusFilter;
      const matchesSheet = dimensionSheetFilter === "ALL" || finding.sheet === dimensionSheetFilter;
      return matchesStatus && matchesSheet;
    });
  }, [dimensionSheetFilter, dimensionStatusFilter, result?.dimensions?.findings]);

  const reportSummary = useMemo(
    () => ({
      sheets: result?.summary.sheetCount ?? 0,
      rooms: result?.roomMeasurements?.summary.roomCount ?? 0,
      tags: result?.openings?.summary.tagCount ?? 0,
      flags: (result?.dimensions?.summary.flagCount ?? 0) + (result?.openings?.summary.flagCount ?? 0),
      verify: (result?.dimensions?.summary.verifyCount ?? 0) + (result?.openings?.summary.verifyCount ?? 0),
      pass: (result?.dimensions?.summary.passCount ?? 0) + (result?.openings?.summary.passCount ?? 0)
    }),
    [result]
  );

  const planCheckSummary = useMemo(() => {
    const pageReviews = result?.pageReviews ?? [];

    return pageReviews.reduce(
      (summary, pageReview) => {
        summary.pages += 1;
        summary.pass += pageReview.review.counts?.pass ?? 0;
        summary.fail += pageReview.review.counts?.fail ?? 0;
        summary.cannotDetermine += pageReview.review.counts?.cannotDetermine ?? 0;
        summary.deficiencies += pageReview.review.deficiencies?.length ?? 0;
        summary.notDetermined += pageReview.review.notDetermined?.length ?? 0;
        if (pageReview.review.overallResult === "REVISIONS REQUIRED") summary.revisions += 1;
        if (pageReview.review.overallResult === "INCOMPLETE SUBMISSION") summary.incomplete += 1;
        return summary;
      },
      {
        pages: 0,
        pass: 0,
        fail: 0,
        cannotDetermine: 0,
        deficiencies: 0,
        notDetermined: 0,
        revisions: 0,
        incomplete: 0
      }
    );
  }, [result?.pageReviews]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? "");
    });
  }, [supabase]);

  const progressState = useMemo(() => {
    const completedSteps = steps.filter((step) => step.state === "done").length;
    const hasRunningStep = steps.some((step) => step.state === "running");
    const percent = Math.min(
      100,
      Math.round(((completedSteps + (hasRunningStep ? 0.45 : 0)) / steps.length) * 100)
    );
    const activeStep = steps.find((step) => step.state === "running");
    const nextStep = steps.find((step) => step.state === "idle");

    return {
      activeStep,
      nextStep,
      percent,
      title: isRunning ? "Checking your plan set" : result ? "Your precheck report is ready" : "Ready to review your plans",
      detail:
        statusMessage ||
        (file
          ? "Click Start plan check. We will split the plan set, read each sheet, and prepare a clear list of items to fix or confirm."
          : "Drop a permit PDF to begin. You will see each stage light up as the review moves forward.")
    };
  }, [file, isRunning, result, statusMessage, steps]);

  function acceptFile(selectedFile?: File) {
    if (!selectedFile || selectedFile.type !== "application/pdf") return;
    setFile(selectedFile);
    setResult(null);
    setError("");
    setStatusMessage("");
    setDimensionStatusFilter("FLAG");
    setDimensionSheetFilter("ALL");
    setExpandedFailPage(null);
    setSteps(defaultSteps);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }

  function mergeUniqueBy<T>(current: T[], incoming: T[], keyFor: (item: T) => string) {
    const map = new Map(current.map((item) => [keyFor(item), item]));
    incoming.forEach((item) => map.set(keyFor(item), item));
    return Array.from(map.values());
  }

  function mergeResultPayload(payload: SplitterResult) {
    setResult((current) => ({
      ...(current ?? payload),
      ...payload,
      sheets: mergeUniqueBy(current?.sheets ?? [], payload.sheets ?? [], (sheet) => sheet.id),
      remotePages: payload.remotePages ?? current?.remotePages,
      pageReviews: mergeUniqueBy(current?.pageReviews ?? [], payload.pageReviews ?? [], (pageReview) =>
        String(pageReview.page)
      ),
      extraction:
        payload.extraction || current?.extraction
          ? {
              summary: payload.extraction?.summary ?? current?.extraction?.summary ?? { extractedSheets: 0, notes: "" },
              sheets: mergeUniqueBy(
                current?.extraction?.sheets ?? [],
                payload.extraction?.sheets ?? [],
                (sheet) => sheet.sheet_id
              )
            }
          : undefined,
      precheck:
        payload.precheck || current?.precheck
          ? {
              summary: {
                blockerCount:
                  (current?.precheck?.summary.blockerCount ?? 0) + (payload.precheck?.summary.blockerCount ?? 0),
                warningCount:
                  (current?.precheck?.summary.warningCount ?? 0) + (payload.precheck?.summary.warningCount ?? 0),
                infoCount: (current?.precheck?.summary.infoCount ?? 0) + (payload.precheck?.summary.infoCount ?? 0),
                clarificationCount:
                  (current?.precheck?.summary.clarificationCount ?? 0) +
                  (payload.precheck?.summary.clarificationCount ?? 0),
                notes: payload.precheck?.summary.notes ?? current?.precheck?.summary.notes ?? ""
              },
              issues: [
                ...(current?.precheck?.issues ?? []),
                ...(payload.precheck?.issues ?? [])
              ]
            }
          : undefined,
      dimensions:
        payload.dimensions || current?.dimensions
          ? {
              summary: {
                passCount:
                  (current?.dimensions?.summary.passCount ?? 0) + (payload.dimensions?.summary.passCount ?? 0),
                verifyCount:
                  (current?.dimensions?.summary.verifyCount ?? 0) + (payload.dimensions?.summary.verifyCount ?? 0),
                flagCount:
                  (current?.dimensions?.summary.flagCount ?? 0) + (payload.dimensions?.summary.flagCount ?? 0),
                notes: payload.dimensions?.summary.notes ?? current?.dimensions?.summary.notes ?? ""
              },
              findings: [
                ...(current?.dimensions?.findings ?? []),
                ...(payload.dimensions?.findings ?? [])
              ]
            }
          : undefined,
      roomMeasurements:
        payload.roomMeasurements || current?.roomMeasurements
          ? {
              summary: {
                roomCount:
                  (current?.roomMeasurements?.summary.roomCount ?? 0) +
                  (payload.roomMeasurements?.summary.roomCount ?? 0),
                dimensionedRoomCount:
                  (current?.roomMeasurements?.summary.dimensionedRoomCount ?? 0) +
                  (payload.roomMeasurements?.summary.dimensionedRoomCount ?? 0),
                notes: payload.roomMeasurements?.summary.notes ?? current?.roomMeasurements?.summary.notes ?? ""
              },
              rooms: [
                ...(current?.roomMeasurements?.rooms ?? []),
                ...(payload.roomMeasurements?.rooms ?? [])
              ]
            }
          : undefined,
      openings:
        payload.openings || current?.openings
          ? {
              summary: {
                tagCount: (current?.openings?.summary.tagCount ?? 0) + (payload.openings?.summary.tagCount ?? 0),
                doorCount: (current?.openings?.summary.doorCount ?? 0) + (payload.openings?.summary.doorCount ?? 0),
                windowCount:
                  (current?.openings?.summary.windowCount ?? 0) + (payload.openings?.summary.windowCount ?? 0),
                passCount: (current?.openings?.summary.passCount ?? 0) + (payload.openings?.summary.passCount ?? 0),
                verifyCount:
                  (current?.openings?.summary.verifyCount ?? 0) + (payload.openings?.summary.verifyCount ?? 0),
                flagCount: (current?.openings?.summary.flagCount ?? 0) + (payload.openings?.summary.flagCount ?? 0),
                notes: payload.openings?.summary.notes ?? current?.openings?.summary.notes ?? ""
              },
              tags: [
                ...(current?.openings?.tags ?? []),
                ...(payload.openings?.tags ?? [])
              ]
            }
          : undefined
    }));
  }

  async function postPipelineAction(action = "full", extra?: Record<string, string>): Promise<SplitterResult> {
    const formData = new FormData();
    formData.append("action", action);
    Object.entries(extra ?? {}).forEach(([key, value]) => formData.append(key, value));
    if (file && (action === "splitRemote" || action === "startAsyncReport")) formData.append("file", file);

    const response = await fetch("/api/sheet-splitter", {
      method: "POST",
      body: formData
    });

    const responseText = await response.text();
    let payload: SplitterResult | { error?: string };

    try {
      payload = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error(
        response.status === 504
          ? "The report took longer than the production server allowed. The split and analysis steps completed, but final report compilation needs more time."
          : `Server returned a non-JSON response (${response.status}).`
      );
    }

    if (!response.ok) {
      const errorMessage = "error" in payload ? payload.error : "";
      throw new Error(errorMessage ?? "Plan precheck failed.");
    }

    if ("error" in payload && payload.error) {
      throw new Error(payload.error);
    }

    mergeResultPayload(payload as SplitterResult);
    return payload as SplitterResult;
  }

  async function reviewS3Page(page: NonNullable<SplitterResult["remotePages"]>[number]) {
    if (!pdfLambdaUrl) {
      throw new Error("PDF review service is not configured.");
    }

    const response = await fetch(pdfLambdaUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        action: "reviewPage",
        page: page.page,
        imageUrl: page.url,
        bucket: page.bucket,
        key: page.key
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? `Page ${page.page} review failed.`);
    }

    return payload as PageReview;
  }

  async function runCompleteReport() {
    if (!file || isRunning) return;

    setIsRunning(true);
    setRunningAction("complete");
    setResult(null);
    setError("");
    setExpandedFailPage(null);
    setStatusMessage("Starting your permit precheck...");
    setSteps(defaultSteps.map((step, index) => ({ ...step, state: index === 0 ? "done" : index === 1 ? "running" : "idle" })));

    try {
      setStatusMessage("Splitting the plan set into individual sheets...");
      const splitPayload = await postPipelineAction("splitRemote", { dpi: "100" });
      const remotePages = splitPayload.remotePages ?? [];
      mergeResultPayload(splitPayload);
      setSteps(defaultSteps.map((step, index) => ({ ...step, state: index <= 2 ? "done" : index === 3 ? "running" : "idle" })));

      for (const remotePage of remotePages) {
        setStatusMessage(`Reading sheet ${remotePage.page} of ${remotePages.length} and checking visible BCBC items...`);
        const pageReview = await reviewS3Page(remotePage);
        mergeResultPayload({ ...splitPayload, pageReviews: [pageReview] });
      }

      setStatusMessage("Building your final precheck report...");

      setSteps(defaultSteps.map((step) => ({ ...step, state: "done" })));
      setStatusMessage("Report complete. Review the fix-or-confirm items below.");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Plan precheck failed.");
      setStatusMessage("");
      setSteps((current) =>
        current.map((step) => (step.state === "running" ? { ...step, state: "idle" } : step))
      );
    } finally {
      setIsRunning(false);
      setRunningAction("");
    }
  }

  async function signOut() {
    if (supabase) {
      await supabase.auth.signOut();
    }

    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Pipeline">
        <div className="brand">
          <div className="brandMark">
            <Building2 size={22} />
          </div>
          <div>
            <strong>Builder Precheck</strong>
            <span>BCBC 2024 support</span>
          </div>
        </div>

        <nav className="nav">
          <a className="active" href="#intake">
            <UploadCloud size={18} />
            Upload
          </a>
          <a href="#review">
            <Layers3 size={18} />
            Review
          </a>
          <a href="#output">
            <CheckCircle2 size={18} />
            Report
          </a>
        </nav>

        <div className="ruleBox">
          <ShieldCheck size={18} />
          <div>
            <strong>Plain-language results</strong>
            <span>Find likely city comments before submission.</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Permit plan precheck</p>
            <h1>Catch permit issues before city review.</h1>
            <p className="topbarCopy">
              Upload your plan set. We split the sheets, read the drawings, and return a builder-friendly BCBC
              checklist.
            </p>
          </div>
          <div className="accountActions">
            <span>{userEmail || "Signed in"}</span>
            <button className="ghostButton" type="button" onClick={signOut}>
              <LogOut size={18} />
              Sign out
            </button>
          </div>
        </header>

        <div className="contentGrid">
          <section className="intakePanel" id="intake">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Start here</p>
                <h2>Upload your plan set</h2>
              </div>
              {file ? (
                <button
                  className="iconButton"
                  type="button"
                  onClick={() => {
                    setFile(null);
                    setResult(null);
                    setError("");
                    setStatusMessage("");
                    setSteps(defaultSteps);
                  }}
                  aria-label="Remove PDF"
                >
                  <X size={18} />
                </button>
              ) : null}
            </div>

            <label
              className={`dropzone ${isDragging ? "dragging" : ""} ${file ? "hasFile" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
            >
              <input
                type="file"
                accept="application/pdf"
                onChange={(event) => acceptFile(event.target.files?.[0])}
              />
              {file ? (
                <div className="fileSummary">
                  <FileText size={38} />
                  <div>
                    <strong>{file.name}</strong>
                    <span>{fileSize} PDF ready for sheet review and BCBC precheck</span>
                  </div>
                </div>
              ) : (
                <div className="emptyDrop">
                  <UploadCloud size={42} />
                  <strong>Drop your permit PDF</strong>
                  <span>or choose the plan set from this computer</span>
                </div>
              )}
            </label>

            <div className="builderPromise">
              {builderPromise.map((item) => (
                <div key={item}>
                  <CheckCircle2 size={16} />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <div className="workflowButtons">
              <button className="runButton magicButton" type="button" disabled={!file || isRunning} onClick={runCompleteReport}>
                {runningAction === "complete" ? <Loader2 className="spin" size={20} /> : <Sparkles size={20} />}
                Start plan check
              </button>
            </div>
            {statusMessage ? (
              <p className={`statusText ${result?.precheck || result?.dimensions ? "precheckStatus" : ""}`}>
                {statusMessage}
              </p>
            ) : null}
            {result?.precheck ? (
              <div className="quickPrecheck">
                <div>
                  <strong>{result.precheck.summary.blockerCount}</strong>
                  <span>blockers</span>
                </div>
                <div>
                  <strong>{result.precheck.summary.warningCount}</strong>
                  <span>warnings</span>
                </div>
                <div>
                  <strong>{result.precheck.summary.infoCount}</strong>
                  <span>info</span>
                </div>
                <div>
                  <strong>{result.precheck.summary.clarificationCount ?? 0}</strong>
                  <span>clarify</span>
                </div>
              </div>
            ) : null}
            {result?.dimensions ? (
              <div className="quickDimensions">
                <div>
                  <strong>{result.dimensions.summary.flagCount}</strong>
                  <span>flags</span>
                </div>
                <div>
                  <strong>{result.dimensions.summary.verifyCount}</strong>
                  <span>verify</span>
                </div>
                <div>
                  <strong>{result.dimensions.summary.passCount}</strong>
                  <span>pass</span>
                </div>
              </div>
            ) : null}
            {result ? (
              <div className="reportOverview">
                <div>
                  <strong>{reportSummary.sheets}</strong>
                  <span>sheets</span>
                </div>
                <div>
                  <strong>{reportSummary.rooms}</strong>
                  <span>rooms</span>
                </div>
                <div>
                  <strong>{reportSummary.tags}</strong>
                  <span>door/window tags</span>
                </div>
                <div>
                  <strong>{reportSummary.pass}</strong>
                  <span>pass</span>
                </div>
                <div>
                  <strong>{reportSummary.verify}</strong>
                  <span>verify</span>
                </div>
                <div>
                  <strong>{reportSummary.flags}</strong>
                  <span>flags</span>
                </div>
              </div>
            ) : null}
            {error ? <p className="errorText">{error}</p> : null}

            <div className="pipeline" id="review">
              {steps.map((step, index) => (
                <div className={`step ${step.state}`} key={step.name}>
                  <span>{index + 1}</span>
                  <strong>{step.name}</strong>
                  {step.state === "done" ? <CheckCircle2 size={17} /> : null}
                  {step.state === "running" ? <Loader2 className="spin" size={17} /> : null}
                </div>
              ))}
            </div>
          </section>

          <section className="progressPanel" aria-live="polite">
            <div className="progressHeader">
              <div>
                <p className="eyebrow">Review progress</p>
                <h2>{progressState.title}</h2>
              </div>
              <div className="progressBadge">
                <strong>{progressState.percent}%</strong>
                <span>complete</span>
              </div>
            </div>

            <div className="progressTrack" aria-label={`Report progress ${progressState.percent}%`}>
              <div className="progressFill" style={{ width: `${progressState.percent}%` }} />
            </div>

            <div className="activeWork">
              <div className={isRunning ? "activePulse running" : "activePulse"}>
                {isRunning ? <Loader2 className="spin" size={22} /> : <ShieldCheck size={22} />}
              </div>
              <div>
                <span className="activeLabel">{progressState.activeStep ? "Current step" : "Next step"}</span>
                <strong>{progressState.activeStep?.name ?? progressState.nextStep?.name ?? "Report ready"}</strong>
                <p>{progressState.detail}</p>
                {progressState.nextStep && progressState.activeStep ? (
                  <em>Next: {progressState.nextStep.name}</em>
                ) : null}
              </div>
            </div>

            <div className="workflowFlow" aria-label="Permit review workflow">
              {steps.map((step, index) => (
                <article className={`flowNode ${step.state}`} key={`progress-${step.name}`}>
                  <span className="flowIndex">{index + 1}</span>
                  <div>
                    <strong>{step.name}</strong>
                    <p>{stepDescriptions[index]}</p>
                    <small>
                      {step.state === "done"
                        ? "Complete"
                        : step.state === "running"
                          ? "Running now"
                          : "Waiting"}
                    </small>
                  </div>
                  {step.state === "done" ? <CheckCircle2 size={18} /> : null}
                  {step.state === "running" ? <Loader2 className="spin" size={18} /> : null}
                </article>
              ))}
            </div>

            <div className="behindScenes">
              <div>
                <strong>What you get</strong>
                <span>A concise list of likely city-review items.</span>
              </div>
              <div>
                <strong>What it checks</strong>
                <span>Rooms, dimensions, doors, windows, notes, and missing information.</span>
              </div>
              <div>
                <strong>How to use it</strong>
                <span>Fix flagged items or confirm anything marked needs information.</span>
              </div>
            </div>
          </section>
        </div>

        <section className="resultsBand" id="output">
          {result ? (
            <div className="compiledReportPanel">
              <div className="resultsHeader">
                <div>
                  <p className="eyebrow">Compiled precheck report</p>
                  <h2>Your builder precheck is ready</h2>
                </div>
                <div className="score">
                  <strong>{reportSummary.flags}</strong>
                  <span>flags</span>
                </div>
              </div>
              <p className="summaryText">
                The PDF was split into review pages, drawing data was extracted, rooms and openings were checked, and
                likely BCBC review items were organized below.
              </p>
              <div className="compiledReportStats">
                <div>
                  <strong>{reportSummary.sheets}</strong>
                  <span>sheets reviewed</span>
                </div>
                <div>
                  <strong>{reportSummary.rooms}</strong>
                  <span>rooms found</span>
                </div>
                <div>
                  <strong>{reportSummary.tags}</strong>
                  <span>openings found</span>
                </div>
                <div>
                  <strong>{reportSummary.pass}</strong>
                  <span>passed checks</span>
                </div>
                <div>
                  <strong>{reportSummary.verify}</strong>
                  <span>needs verification</span>
                </div>
                <div>
                  <strong>{reportSummary.flags}</strong>
                  <span>flagged checks</span>
                </div>
              </div>
            </div>
          ) : null}

          {result?.pageReviews?.length ? (
            <div className="compiledReportPanel">
              <div className="resultsHeader">
                <div>
                  <p className="eyebrow">BCBC page review</p>
                  <h2>
                    {planCheckSummary.pages} pages checked, {planCheckSummary.deficiencies} likely deficiencies found
                  </h2>
                </div>
                <div className="score">
                  <strong>{planCheckSummary.fail}</strong>
                  <span>failed checks</span>
                </div>
              </div>
              <p className="summaryText">
                Each sheet was reviewed and summarized into plain next steps for the builder or designer.
              </p>
              <div className="compiledReportStats">
                <div>
                  <strong>{planCheckSummary.pass}</strong>
                  <span>pass</span>
                </div>
                <div>
                  <strong>{planCheckSummary.fail}</strong>
                  <span>fail</span>
                </div>
                <div>
                  <strong>{planCheckSummary.cannotDetermine}</strong>
                  <span>need info</span>
                </div>
                <div>
                  <strong>{planCheckSummary.deficiencies}</strong>
                  <span>deficiencies</span>
                </div>
                <div>
                  <strong>{planCheckSummary.revisions}</strong>
                  <span>revision pages</span>
                </div>
                <div>
                  <strong>{planCheckSummary.incomplete}</strong>
                  <span>incomplete pages</span>
                </div>
              </div>
              <div className="pageReviewList">
                {result.pageReviews
                  .slice()
                  .sort((first, second) => first.page - second.page)
                  .map((pageReview) => {
                    const failedChecks = pageReview.review.checks?.filter((check) => check.verdict === "FAIL") ?? [];
                    const isFailExpanded = expandedFailPage === pageReview.page;

                    return (
                      <article className="pageReviewCard" key={`page-review-${pageReview.page}`}>
                        <div className="pageReviewHeader">
                          <div>
                            <strong>
                              Page {pageReview.page} · {pageReview.review.sheet || pageReview.review.title}
                            </strong>
                            <span>{pageReview.review.drawingType || "Drawing page"}</span>
                          </div>
                          <em>{pageReview.review.overallResult}</em>
                        </div>
                        <p>{pageReview.review.summary}</p>
                        <div className="openingSummary">
                          <div>
                            <strong>{pageReview.review.counts?.pass ?? 0}</strong>
                            <span>pass</span>
                          </div>
                          <button
                            className={`summaryAction fail ${isFailExpanded ? "active" : ""}`}
                            type="button"
                            disabled={!failedChecks.length && !pageReview.review.deficiencies?.length}
                            onClick={() => setExpandedFailPage(isFailExpanded ? null : pageReview.page)}
                            aria-expanded={isFailExpanded}
                            aria-controls={`page-${pageReview.page}-failed-items`}
                          >
                            <strong>{pageReview.review.counts?.fail ?? 0}</strong>
                            <span>{isFailExpanded ? "hide failed items" : "show failed items"}</span>
                          </button>
                          <div>
                            <strong>{pageReview.review.counts?.cannotDetermine ?? 0}</strong>
                            <span>need info</span>
                          </div>
                        </div>
                        {isFailExpanded ? (
                          <div className="failureActionPanel" id={`page-${pageReview.page}-failed-items`}>
                            <div className="failureActionHeader">
                              <strong>Items to fix before submission</strong>
                              <span>
                                These are the checks marked fail for this sheet. Use the correction notes as your action
                                list.
                              </span>
                            </div>
                            {failedChecks.length ? (
                              <div className="failureList">
                                {failedChecks.map((check, index) => (
                                  <article className="failureItem" key={`${pageReview.page}-failed-check-${index}`}>
                                    <div>
                                      <strong>{check.category}</strong>
                                      <em>{check.codeReference}</em>
                                    </div>
                                    <dl>
                                      <div>
                                        <dt>Requirement</dt>
                                        <dd>{check.requirement}</dd>
                                      </div>
                                      <div>
                                        <dt>What the plan shows</dt>
                                        <dd>{check.observation}</dd>
                                      </div>
                                      <div>
                                        <dt>Builder action</dt>
                                        <dd>{check.requiredCorrection || "Revise the drawing or provide clarification."}</dd>
                                      </div>
                                    </dl>
                                  </article>
                                ))}
                              </div>
                            ) : (
                              <p className="summaryText">No detailed failed checks were returned for this sheet.</p>
                            )}
                            {pageReview.review.deficiencies?.length ? (
                              <details className="needsInfoDetails deficiencyDetails">
                                <summary>{pageReview.review.deficiencies.length} deficiency notice(s)</summary>
                                <div className="issueList compact">
                                  {pageReview.review.deficiencies.map((deficiency, index) => (
                                    <article className="issueItem blocker" key={`${pageReview.page}-deficiency-${index}`}>
                                      <strong>{deficiency.codeReference}</strong>
                                      <p>{deficiency.observedCondition}</p>
                                      <span>{deficiency.requiredCorrection}</span>
                                    </article>
                                  ))}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                        {pageReview.review.notDetermined?.length ? (
                          <details className="needsInfoDetails">
                            <summary>{pageReview.review.notDetermined.length} items need more information</summary>
                            <ul>
                              {pageReview.review.notDetermined.slice(0, 8).map((item, index) => (
                                <li key={`${pageReview.page}-nd-${index}`}>
                                  <strong>{item.item}:</strong> {item.neededInformation}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </article>
                    );
                  })}
              </div>
            </div>
          ) : null}

          {result?.roomMeasurements ? (
            <div className="roomMeasurementsPanel">
              <div className="resultsHeader">
                <div>
                  <p className="eyebrow">Room measurement extractor</p>
                  <h2>
                    {result.roomMeasurements.summary.dimensionedRoomCount} dimensioned rooms from{" "}
                    {result.roomMeasurements.summary.roomCount} room records
                  </h2>
                </div>
                <div className="score">
                  <strong>{result.roomMeasurements.summary.roomCount}</strong>
                  <span>rooms</span>
                </div>
              </div>
              <p className="summaryText">{result.roomMeasurements.summary.notes}</p>
              <div className="roomMeasurementTable">
                <div className="roomMeasurementHeader">
                  <span>Sheet</span>
                  <span>Room</span>
                  <span>Measurement</span>
                  <span>Doors</span>
                  <span>Notes</span>
                </div>
                {result.roomMeasurements.rooms.map((room, index) => (
                  <article className="roomMeasurementRow" key={`${room.sheet_id}-${room.room_name}-${index}`}>
                    <span>
                      <strong>{room.sheet_id}</strong>
                      <small>{room.sheet_title}</small>
                    </span>
                    <span>{room.room_name}</span>
                    <span>
                      <strong>{room.dimensions ?? "not shown"}</strong>
                      {room.area ? <small>{room.area}</small> : null}
                    </span>
                    <span>{room.door_tags.length ? room.door_tags.join(", ") : "none"}</span>
                    <span>{room.notes || room.source}</span>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {result?.openings ? (
            <div className="roomMeasurementsPanel">
              <div className="resultsHeader">
                <div>
                  <p className="eyebrow">Door/window egress tags</p>
                  <h2>
                    {result.openings.summary.doorCount} doors, {result.openings.summary.windowCount} windows
                  </h2>
                </div>
                <div className="score">
                  <strong>{result.openings.summary.flagCount}</strong>
                  <span>flags</span>
                </div>
              </div>
              <p className="summaryText">{result.openings.summary.notes}</p>
              <div className="openingSummary">
                <div>
                  <strong>{result.openings.summary.passCount}</strong>
                  <span>pass</span>
                </div>
                <div>
                  <strong>{result.openings.summary.verifyCount}</strong>
                  <span>verify</span>
                </div>
                <div>
                  <strong>{result.openings.summary.flagCount}</strong>
                  <span>flag</span>
                </div>
              </div>
              <div className="roomMeasurementTable">
                <div className="openingHeader">
                  <span>Sheet</span>
                  <span>Tag</span>
                  <span>Room</span>
                  <span>Decoded size</span>
                  <span>Egress check</span>
                </div>
                {result.openings.tags.map((tag, index) => (
                  <article className={`openingRow ${tag.egress_status.toLowerCase()}`} key={`${tag.sheet_id}-${tag.kind}-${tag.tag}-${index}`}>
                    <span>
                      <strong>{tag.sheet_id}</strong>
                      <small>{tag.sheet_title}</small>
                    </span>
                    <span>
                      <strong>{tag.kind.toUpperCase()} {tag.tag}</strong>
                      <small>{tag.source}</small>
                    </span>
                    <span>{tag.room_name}</span>
                    <span>{tag.decoded_size ?? "not decoded"}</span>
                    <span>
                      <strong>{tag.egress_status}</strong>
                      <small>{tag.egress_note}</small>
                    </span>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          {result?.precheck ? (
            <div className="precheckPanel">
              <div className="resultsHeader">
                <div>
                  <p className="eyebrow">Precheck output</p>
                  <h2>
                    {result.precheck.summary.blockerCount} blockers, {result.precheck.summary.warningCount} warnings
                    {result.precheck.summary.clarificationCount ? `, ${result.precheck.summary.clarificationCount} clarifications` : ""}
                  </h2>
                </div>
                <div className="score">
                  <strong>{result.precheck.issues.length}</strong>
                  <span>issues</span>
                </div>
              </div>
              <p className="summaryText">{result.precheck.summary.notes}</p>
              <div className="issueList">
                {result.precheck.issues.map((issue, index) => (
                  <article className={`issueItem ${issue.severity}`} key={`${issue.sheet_id}-${issue.category}-${index}`}>
                    <strong>
                    {issue.sheet_id} · {issue.category}
                  </strong>
                  <p>{issue.issue}</p>
                  {issue.evidence ? <em>{issue.evidence}</em> : null}
                  <span>{issue.recommended_action}</span>
                  {issue.source ? <small>{issue.source}</small> : null}
                </article>
              ))}
              </div>
            </div>
          ) : null}

          {result?.dimensions ? (
            <div className="dimensionPanel">
              <div className="resultsHeader">
                <div>
                  <p className="eyebrow">Dimension review output</p>
                  <h2>
                    {result.dimensions.summary.flagCount} flags, {result.dimensions.summary.verifyCount} verify,{" "}
                    {result.dimensions.summary.passCount} pass
                  </h2>
                </div>
                <div className="score">
                  <strong>{result.dimensions.findings.length}</strong>
                  <span>checks</span>
                </div>
              </div>
              <p className="summaryText">{result.dimensions.summary.notes}</p>
              <div className="dimensionFilters" aria-label="Dimension review filters">
                <div className="filterGroup" role="group" aria-label="Filter by status">
                  {[
                    { label: "All", value: "ALL", count: result.dimensions.findings.length },
                    { label: "Flags", value: "FLAG", count: result.dimensions.summary.flagCount },
                    { label: "Verify", value: "VERIFY", count: result.dimensions.summary.verifyCount },
                    { label: "Pass", value: "PASS", count: result.dimensions.summary.passCount }
                  ].map((filter) => (
                    <button
                      className={dimensionStatusFilter === filter.value ? "active" : ""}
                      key={filter.value}
                      type="button"
                      onClick={() => setDimensionStatusFilter(filter.value as DimensionStatusFilter)}
                    >
                      {filter.label}
                      <span>{filter.count}</span>
                    </button>
                  ))}
                </div>
                <label className="sheetFilter">
                  <span>Sheet</span>
                  <select value={dimensionSheetFilter} onChange={(event) => setDimensionSheetFilter(event.target.value)}>
                    <option value="ALL">All sheets</option>
                    {dimensionSheets.map((sheet) => (
                      <option value={sheet} key={sheet}>
                        {sheet}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="filterCount">
                Showing {filteredDimensionFindings.length} of {result.dimensions.findings.length} checks
              </p>
              <div className="dimensionList">
                {filteredDimensionFindings.map((finding, index) => (
                  <article className={`dimensionItem ${finding.status.toLowerCase()}`} key={`${finding.check_id}-${index}`}>
                    <div>
                      <strong>
                        {finding.sheet} · {finding.element}
                      </strong>
                      <span>{finding.status}</span>
                    </div>
                    <p>{finding.note || "Meets extracted dimensional requirement."}</p>
                    <dl>
                      <div>
                        <dt>Extracted</dt>
                        <dd>{finding.extracted_value}</dd>
                      </div>
                      <div>
                        <dt>Required</dt>
                        <dd>{finding.required_value}</dd>
                      </div>
                      <div>
                        <dt>BCBC</dt>
                        <dd>
                          {finding.bcbc_clause}
                          {finding.bcbc_table ? ` · ${finding.bcbc_table}` : ""}
                        </dd>
                      </div>
                    </dl>
                    {finding.downstream ? <small>{finding.downstream}</small> : null}
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
