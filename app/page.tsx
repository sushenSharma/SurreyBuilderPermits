"use client";

import {
  Building2,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Layers3,
  Loader2,
  Play,
  ScanLine,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X
} from "lucide-react";
import { DragEvent, useMemo, useState } from "react";

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

type PipelineAction = "full" | "split" | "extract" | "precheck" | "dimensions" | "rooms" | "openings";

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
};

const defaultSteps: AgentStep[] = [
  { name: "PDF intake", state: "idle" },
  { name: "Sheet splitting", state: "idle" },
  { name: "Vision extraction", state: "idle" },
  { name: "Rooms, doors, windows", state: "idle" },
  { name: "BCBC comparison", state: "idle" },
  { name: "Report ready", state: "idle" }
];

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runningAction, setRunningAction] = useState("");
  const [result, setResult] = useState<SplitterResult | null>(null);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [dimensionStatusFilter, setDimensionStatusFilter] = useState<DimensionStatusFilter>("FLAG");
  const [dimensionSheetFilter, setDimensionSheetFilter] = useState("ALL");
  const [steps, setSteps] = useState(defaultSteps);

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
      title: isRunning ? "Working behind the scenes" : result ? "BCBC report ready" : "Ready for a permit PDF",
      detail:
        statusMessage ||
        (file
          ? "Click Create BCBC report to split the plan set, extract measurements, and compare against the local BCBC skill."
          : "Drop a permit PDF to begin. Progress will stay visible here while each agent runs.")
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
    setSteps(defaultSteps);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }

  function mergeResultPayload(payload: SplitterResult) {
    setResult((current) => ({
      ...(current ?? payload),
      ...payload,
      extraction: payload.extraction ?? current?.extraction,
      precheck: payload.precheck ?? current?.precheck,
      dimensions: payload.dimensions ?? current?.dimensions,
      roomMeasurements: payload.roomMeasurements ?? current?.roomMeasurements,
      openings: payload.openings ?? current?.openings
    }));
  }

  async function postPipelineAction(action: PipelineAction) {
    const formData = new FormData();
    formData.append("action", action);
    if (file) formData.append("file", file);

    const response = await fetch("/api/sheet-splitter", {
      method: "POST",
      body: formData
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Plan precheck failed.");
    }

    mergeResultPayload(payload);
    return payload;
  }

  async function runCompleteReport() {
    if (!file || isRunning) return;

    setIsRunning(true);
    setRunningAction("complete");
    setResult(null);
    setError("");
    setStatusMessage("Starting complete BCBC report...");
    setSteps(defaultSteps.map((step, index) => ({ ...step, state: index === 0 ? "done" : index === 1 ? "running" : "idle" })));

    const stageMessages = [
      "Splitting PDF into sheets...",
      "Extracting sheet data with vision...",
      "Extracting room measurements...",
      "Extracting door and window tags...",
      "Comparing against BCBC skill...",
      "Compiling report..."
    ];
    let stageIndex = 0;
    const progressTimer = window.setInterval(() => {
      stageIndex = Math.min(stageIndex + 1, defaultSteps.length - 1);
      setStatusMessage(stageMessages[stageIndex] ?? "Compiling report...");
      setSteps((current) =>
        current.map((step, index) => {
          if (index < stageIndex) return { ...step, state: "done" };
          if (index === stageIndex) return { ...step, state: "running" };
          return { ...step, state: "idle" };
        })
      );
    }, 4500);

    try {
      await postPipelineAction("full");
      setSteps(defaultSteps.map((step) => ({ ...step, state: "done" })));
      setStatusMessage("Report complete. Rooms, openings, and BCBC checks are ready.");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Plan precheck failed.");
      setStatusMessage("");
      setSteps((current) =>
        current.map((step) => (step.state === "running" ? { ...step, state: "idle" } : step))
      );
    } finally {
      window.clearInterval(progressTimer);
      setIsRunning(false);
      setRunningAction("");
    }
  }

  async function runStep(action: PipelineAction) {
    if ((action === "split" && !file) || isRunning) return;
    const actionLabel =
      action === "split"
        ? "Splitting PDF"
        : action === "extract"
          ? "Extracting saved sheets"
          : action === "precheck"
            ? "Running precheck"
            : action === "dimensions"
              ? "Reviewing dimensions"
              : action === "rooms"
                ? "Extracting room measurements"
                : "Extracting door/window tags";
    setIsRunning(true);
    setRunningAction(action);
    setError("");
    setStatusMessage(`${actionLabel}...`);
    setSteps(defaultSteps.map((step, index) => ({ ...step, state: index === 0 ? "running" : "idle" })));

    const progressTimer = window.setInterval(() => {
      setSteps((current) => {
        const runningIndex = current.findIndex((step) => step.state === "running");
        if (runningIndex === -1 || runningIndex === current.length - 1) return current;

        return current.map((step, stepIndex) => {
          if (stepIndex <= runningIndex) return { ...step, state: "done" };
          if (stepIndex === runningIndex + 1) return { ...step, state: "running" };
          return step;
        });
      });
    }, 900);

    try {
      const payload = await postPipelineAction(action);
      if (action === "precheck" && payload.precheck) {
        setStatusMessage(
          `Precheck complete: ${payload.precheck.summary.blockerCount} blockers, ${payload.precheck.summary.warningCount} warnings, ${payload.precheck.summary.clarificationCount ?? 0} clarifications, ${payload.precheck.summary.infoCount} info.`
        );
      } else if (action === "dimensions" && payload.dimensions) {
        setStatusMessage(
          `Dimensions complete: ${payload.dimensions.summary.flagCount} flags, ${payload.dimensions.summary.verifyCount} verify, ${payload.dimensions.summary.passCount} pass.`
        );
      } else if (action === "rooms" && payload.roomMeasurements) {
        setStatusMessage(
          `Room measurements complete: ${payload.roomMeasurements.summary.dimensionedRoomCount} of ${payload.roomMeasurements.summary.roomCount} rooms have dimensions.`
        );
      } else if (action === "openings" && payload.openings) {
        setStatusMessage(
          `Door/window tags complete: ${payload.openings.summary.doorCount} doors, ${payload.openings.summary.windowCount} windows, ${payload.openings.summary.flagCount} flags.`
        );
      } else if (action === "extract" && payload.extraction) {
        setStatusMessage(`Extraction complete: ${payload.extraction.summary.extractedSheets} saved sheets extracted.`);
      } else {
        setStatusMessage(`Split complete: ${payload.summary.sheetCount} sheets saved.`);
      }
      setSteps(defaultSteps.map((step) => ({ ...step, state: "done" })));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Sheet splitter failed.");
      setStatusMessage("");
      setSteps((current) =>
        current.map((step) => (step.state === "running" ? { ...step, state: "idle" } : step))
      );
    } finally {
      window.clearInterval(progressTimer);
      setIsRunning(false);
      setRunningAction("");
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Pipeline">
        <div className="brand">
          <div className="brandMark">
            <Building2 size={22} />
          </div>
          <div>
            <strong>Permit Precheck</strong>
            <span>BCBC 2024 ready</span>
          </div>
        </div>

        <nav className="nav">
          <a className="active" href="#intake">
            <UploadCloud size={18} />
            Intake
          </a>
          <a href="#agents">
            <Layers3 size={18} />
            Agents
          </a>
          <a href="#output">
            <ClipboardCheck size={18} />
            Output
          </a>
        </nav>

        <div className="ruleBox">
          <ShieldCheck size={18} />
          <div>
            <strong>Skill loader</strong>
            <span>BCBC checks staged for downstream agents.</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Permit plan intelligence</p>
            <h1>Drop a plan set. Get a BCBC precheck report.</h1>
          </div>
          <button className="ghostButton" type="button">
            <Sparkles size={18} />
            Claude vision + local BCBC skills
          </button>
        </header>

        <div className="contentGrid">
          <section className="intakePanel" id="intake">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">One click report</p>
                <h2>Upload permit PDF</h2>
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
                    <span>{fileSize} PDF queued for room, opening, and BCBC review</span>
                  </div>
                </div>
              ) : (
                <div className="emptyDrop">
                  <UploadCloud size={42} />
                  <strong>Drop permit PDF</strong>
                  <span>or choose a file from this machine</span>
                </div>
              )}
            </label>

            <div className="workflowButtons">
              <button className="runButton magicButton" type="button" disabled={!file || isRunning} onClick={runCompleteReport}>
                {runningAction === "complete" ? <Loader2 className="spin" size={20} /> : <Sparkles size={20} />}
                Create BCBC report
              </button>
              <div className="advancedActions" aria-label="Advanced stage controls">
                <button className="secondaryButton" type="button" disabled={!file || isRunning} onClick={() => runStep("split")}>
                  {runningAction === "split" ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                  Split
                </button>
                <button className="secondaryButton" type="button" disabled={isRunning} onClick={() => runStep("extract")}>
                  {runningAction === "extract" ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                  Extract
                </button>
                <button className="secondaryButton" type="button" disabled={isRunning} onClick={() => runStep("rooms")}>
                  {runningAction === "rooms" ? <Loader2 className="spin" size={18} /> : <ScanLine size={18} />}
                  Rooms
                </button>
                <button className="secondaryButton" type="button" disabled={isRunning} onClick={() => runStep("openings")}>
                  {runningAction === "openings" ? <Loader2 className="spin" size={18} /> : <ScanLine size={18} />}
                  Tags
                </button>
                <button className="secondaryButton" type="button" disabled={isRunning} onClick={() => runStep("dimensions")}>
                  {runningAction === "dimensions" ? <Loader2 className="spin" size={18} /> : <ClipboardCheck size={18} />}
                  BCBC
                </button>
              </div>
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

            <div className="pipeline" id="agents">
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
                <p className="eyebrow">Report progress</p>
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
                <strong>{progressState.activeStep?.name ?? progressState.nextStep?.name ?? "Report ready"}</strong>
                <p>{progressState.detail}</p>
              </div>
            </div>

            <div className="progressTimeline">
              {steps.map((step, index) => (
                <article className={`progressStep ${step.state}`} key={`progress-${step.name}`}>
                  <span>{index + 1}</span>
                  <div>
                    <strong>{step.name}</strong>
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
                <strong>Saved sheets</strong>
                <span>Reuses split pages during testing.</span>
              </div>
              <div>
                <strong>Claude vision</strong>
                <span>Extracts rooms, dimensions, doors, and windows.</span>
              </div>
              <div>
                <strong>BCBC skill</strong>
                <span>Compares extracted data against local review rules.</span>
              </div>
            </div>
          </section>
        </div>

        <section className="resultsBand" id="output">
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
