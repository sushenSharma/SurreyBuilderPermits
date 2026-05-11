import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ClaudeContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_use";
      name: string;
      input: unknown;
    };

type PageSheetMetadata = {
  page: number;
  sheetNumber: string;
  title: string;
  scale: string;
  confidence: number;
  status: "ready" | "warning" | "review";
  notes: string;
  detectedElementCounts: {
    titleBlocks: number;
    northArrows: number;
    scaleBars: number;
    roomLabels: number;
    doorTags: number;
    windowTags: number;
    dimensionStrings: number;
  };
  warnings: string[];
};

type Sheet = {
  id: string;
  title: string;
  range: string;
  confidence: number;
  status: "ready" | "warning" | "review";
  notes: string;
};

type SplitSheet = Sheet & {
  pages: number[];
  building: string;
  metadata: {
    scale_main: string | null;
    scale_secondary: string | null;
  };
  detected_elements: {
    dimension_strings: number;
    door_tags: number;
    window_tags: number;
    room_labels: number;
  };
};

type SplitResult = {
  summary: {
    sheetCount: number;
    needsReview: number;
    notes: string;
  };
  sheets: SplitSheet[];
  handoff: {
    visionExtractor: string[];
    textExtractor: string[];
    crossSheetRisks: string[];
  };
  pages: PageSheetMetadata[];
};

type PrecheckIssue = {
  severity: "blocker" | "warning" | "info" | "needs_clarification";
  sheet_id: string;
  category: string;
  issue: string;
  source: string;
  evidence: string;
  recommended_action: string;
  official_source_url: string;
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

const execFileAsync = promisify(execFile);

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_DPI = 200;
const MAX_DPI = 300;
const PAGE_CONCURRENCY = 2;
const SHEET_EXTRACTION_CONCURRENCY = 1;
const OUTPUT_ROOT = join(process.cwd(), "output");
const SURREY_SKILL_ROOT = join(process.cwd(), "skills", "surrey-plan-precheck");
const DIMENSIONS_SKILL_PATH = join(process.cwd(), "skills", "bcbc-dimensions", "SKILL.md");
const BCBC_2024_SKILL_PATH = join(process.cwd(), "skills", "bc-building-code-2024", "SKILL.md");
const OFFICIAL_SOURCES = {
  surreyBylaws: "https://www.surrey.ca/city-government/bylaws",
  surreyRegulatoryBylaws: "https://www.surrey.ca/city-government/bylaws/regulatory-bylaws",
  surreyZoning: "https://www.surrey.ca/city-government/bylaws/zoning",
  surreyZoningBylaw12000: "https://www.surrey.ca/sites/default/files/bylaws/BYL_Zoning_12000.pdf",
  surreyDcc: "https://www.surrey.ca/renovating-building-development/engineering-infrastructure/development-cost-charges",
  bcbc2024:
    "https://www2.gov.bc.ca/gov/content/industry/construction-industry/building-codes-standards/bc-codes/2024-bc-codes"
};

const BASE_SYSTEM = `You are an expert architectural drawing analyst.
Your job is to extract every piece of data from an architectural drawing sheet into structured JSON.
CRITICAL: Never round, summarize, or paraphrase dimension values.
"9'2\\" x 11'10\\"" must appear exactly as written. "7½\\"" stays as "7½\\"" not "7.5 inches".`;

const BCBC_PAGE_CHECK_PROMPT = `You are an experienced BC Building Code 2024 Plan Checker (Plans Examiner)
operating under Division B, Part 9 of the British Columbia Building Code 2024
(Housing and Small Buildings). You have deep knowledge of all requirements in
Sections 9.3 through 9.8 as captured in your skill reference file.

When the user uploads a floor plan, elevation drawing, or section drawing,
you will conduct a systematic plan check exactly as a municipal plans examiner
would. Your review must be thorough, structured, and code-referenced.

## YOUR REVIEW PROCESS

### STEP 1 — Drawing Intake & Identification
Before checking anything, identify and state:
- Type of drawing submitted (floor plan, elevation, section, site plan)
- Which floor or level it represents (basement, main floor, upper floor, etc.)
- Apparent occupancy type (single dwelling unit, house with secondary suite,
  multi-unit residential, etc.)
- Scale or dimensions visible on the drawing
- What information appears to be missing that would be needed for a complete
  plan check (e.g. ceiling heights not noted, stair dimensions absent, etc.)

### STEP 2 — Systematic Code Review

Work through each category below in order. For every item:
- STATE the requirement (cite the exact Article and Sentence)
- STATE what you observe on the drawing
- GIVE A VERDICT: PASS / FAIL / CANNOT DETERMINE (if information is missing)
- If FAIL: state exactly what needs to be corrected
- If CANNOT DETERMINE: state exactly what additional information is needed

#### 2A — Room Dimensions and Ceiling Heights (Section 9.5.3, Table 9.5.3.1)
Check every labeled room or space:
- Minimum ceiling height for each room type
- Minimum area over which ceiling height must be provided
- Clear heights where applicable (e.g. other bedroom spaces, 2.0 m clear)
- Unfinished basement clear height (2.1 m under beams and in passages)
- Storage garage clear height (minimum 2.0 m)
- Mezzanine ceiling heights above and below (2.1 m each, non-residential)

#### 2B — Hallway Widths (Section 9.5.4)
- Minimum unobstructed hallway width (860 mm general)
- Permitted 710 mm reduction conditions (only bedrooms/bathrooms at end,
  second exit provided)

#### 2C — Doorway Sizes (Section 9.5.5, Table 9.5.5.1)
Check every door shown on the plan:
- Required entrance to dwelling unit (810 mm wide × 1 980 mm high)
- Vestibule/entrance hall (810 × 1 980)
- Exterior-to-basement passage (810 × 1 980)
- Walk-in closet (610 × 1 980)
- Bathroom/WC/shower room (610 × 1 980)
- Rooms off 710 mm hallways (610 × 1 980)
- All other rooms and exterior balconies (760 × 1 980)
- Public WC rooms (810 wide × 2 030 high)
- Doorways to rooms with bathtub/shower/WC served by 860 mm hallway
  (at least one door ≥ 760 mm wide)

#### 2D — Stair Dimensions (Section 9.8)
If stairs are shown or referenced:
- Stair width (860 mm for dwelling unit; 900 mm for residential exit/public)
- Clear height over stairs (1 950 mm for dwelling unit; 2 050 mm general)
- Riser height (max 200 mm / min 125 mm private; max 180 mm / min 125 mm public)
- Tread run (max 355 mm / min 255 mm private; min 280 mm public)
- Maximum flight height (3.7 m)
- Minimum risers in interior flights (3, except within dwelling unit)
- Winder configuration compliance if winders are shown
- Tread nosing requirements (6–14 mm rounded/beveled)
- Open risers (only permitted for dwelling units, fire escapes, maintenance,
  service rooms, industrial non-storage)
- Stair configuration (straight, curved, winders — confirm permitted type)

#### 2E — Landings (Section 9.8.6)
- Landing required at top and bottom of each flight
- Landing required where door opens onto stair or ramp
- Landing dimensions (at least as wide and long as stair width)
- Where turn < 90°: length need not exceed lesser of required stair width
  or 1 100 mm
- Slope of landing (must not exceed 1 in 50)
- Clear height over landing (2 050 mm general; 1 950 mm dwelling unit)
- Permitted omissions (door swings away at top; secondary entrance ≤ 3 risers;
  bottom of exterior stair with no obstruction within 900/1 100 mm)

#### 2F — Handrails (Section 9.8.7, Table 9.8.7.1)
- Number of sides required (refer to Table 9.8.7.1 — stair width,
  curved vs straight, location)
- Not required thresholds (≤ 2 interior risers; ≤ 3 exterior risers;
  ramp rise ≤ 400 mm — for dwelling unit only)
- Handrail height range (865 mm to 1 070 mm)
- Continuity (continuously graspable from bottom riser to top riser)
- 300 mm horizontal extension beyond top and bottom of flight
  (not required for single dwelling unit)
- Clearance behind handrail (≥ 50 mm; 60 mm if rough/abrasive surface)
- 750 mm from natural path of travel (where stair serves > 2 dwelling units)

#### 2G — Guards (Section 9.8.8)
- Guard required where elevation difference > 600 mm within 1.2 m
  of walking surface
- Applies to: stairs, ramps, landings, porches, balconies, mezzanines,
  galleries, raised walkways
- Doors: where floor > 600 mm above other side (guard or 100 mm max opening)
- Openable windows: guard or tool-releasable mechanism limiting opening
  to ≤ 100 mm (unless bottom edge > 900 mm above floor, or > 1 800 mm
  above exterior grade)
- Glazing over stairs/ramps/landings:
  - General buildings: guard required if glazing extends < 1 070 mm above
    tread/ramp/landing surface
  - Dwelling units: guard required if glazing extends < 900 mm above
    tread/ramp/landing surface
  - Public areas above second storey: guard or withstand balcony loads
    if glazing < 1 m from floor

#### 2H — Windows, Doors and Skylights (Section 9.7)
- Main entrance door: door viewer, transparent glazing, or sidelight required
- Thermal break required in metal frames (unless storm window/door or
  fire-rated)
- Sliding doors: pin-lock mechanism ≥ 9 mm throw (or ASTM F842 Grade 10);
  panel not removable when locked
- Swinging entry doors: solid core or stile-and-rail, ≥ 45 mm thick;
  deadbolt ≥ 5 pins, bolt ≥ 25 mm throw; hinge screws ≥ 2 per hinge
  penetrating ≥ 30 mm into solid wood; strikeplate screws ≥ 30 mm into wood;
  solid blocking at lock height; outswing doors need non-removable hinges
- Windows within 2 m of ground level: must meet AAMA/WDMA/CSA 101/I.S.2/A440
  Clause 5.3.6 forced entry resistance
- All windows/doors/skylights sealed to air barriers

#### 2I — Glass and Glazing (Section 9.6)
- Glass sidelights > 500 mm wide: must be safety (tempered/laminated) or
  wired glass
- Entrance door glass > 0.5 m² extending < 900 mm from door bottom:
  safety or wired glass
- Shower/bathtub enclosure: Class A CAN/CGSB-12.1 safety glazing
- Transparent panels mistakable for egress: barriers or railings required
- Public-accessible glass/transparent doors: hardware making existence apparent

#### 2J — Accessible Design (Section 9.5.2)
- Every building shall comply with Section 3.8 (flag if not residential
  single-family)
- Apartment buildings: accessible path through all common spaces of
  entrance storeys
- Note floor levels exempt from accessible path (not served by elevator/ramp,
  not entrance level, no unique common facilities)

### STEP 3 — Summary Table

Produce a clean summary table at the end:

| Item | Code Reference | Observation | Verdict |
|------|---------------|-------------|---------|
| [Each checked item] | [Article X.X.X.X] | [What drawing shows] | PASS / FAIL / N/D |

### STEP 4 — Deficiency List

List ALL items that received a FAIL verdict, formatted as a numbered
deficiency notice exactly as a city would issue it:

DEFICIENCY #1
Code Reference: Article X.X.X.X, Sentence (X)
Requirement: [State the code requirement]
Observed Condition: [What the drawing shows]
Required Correction: [Exactly what must be changed on the drawing]

### STEP 5 — Items Not Determinable

List all CANNOT DETERMINE items and state exactly what information or
additional drawing (e.g. section, elevation, reflected ceiling plan,
door schedule) must be provided before those items can be checked.

### STEP 6 — Overall Result

State one of:
- APPROVED — No deficiencies found. Drawing complies with BCBC 2024
  Division B Part 9 for all checked items.
- REVISIONS REQUIRED — [X] deficiencies found. Resubmit corrected
  drawings addressing all items in the Deficiency List above.
- INCOMPLETE SUBMISSION — Insufficient information to complete plan check.
  Provide the additional information listed in Step 5 before resubmission.

## IMPORTANT RULES FOR YOUR REVIEW

1. Always cite the exact Article number and Sentence when stating a
   requirement. Never state a code requirement without its citation.
2. Never guess dimensions. If a dimension is not shown on the drawing,
   mark it CANNOT DETERMINE — do not assume it complies.
3. Be conservative. When in doubt, flag it. A plans examiner's job is
   to protect the safety of future occupants.
4. Do not approve what you cannot see. Only mark PASS when the drawing
   clearly shows compliance.
5. Note any reserved sentences (e.g. 9.7.3.1 Sentence 1 is reserved)
   and skip them without comment.
6. If the drawing shows something clearly non-compliant even if not in
   the checklist above, flag it anyway.
7. State your occupancy assumption at the top and note that the review
   is limited to Part 9 (Housing and Small Buildings). If the building
   appears to be non-residential or mixed-use, flag that Part 3 review
   may also be required.`;

const pageMetadataSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "number" },
    sheetNumber: {
      type: "string",
      description: "Sheet number from the title block, such as A101 or S101. Use UNKNOWN-pageNumber if unclear."
    },
    title: {
      type: "string",
      description: "Sheet title from the title block or best inference."
    },
    scale: {
      type: "string",
      description: "Detected drawing scale. Use UNKNOWN if not visible."
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 100
    },
    status: {
      type: "string",
      enum: ["ready", "warning", "review"]
    },
    notes: {
      type: "string",
      description: "Concise page-level notes about title block, OCR, sheet boundaries, or split risk."
    },
    detectedElementCounts: {
      type: "object",
      additionalProperties: false,
      properties: {
        titleBlocks: { type: "number" },
        northArrows: { type: "number" },
        scaleBars: { type: "number" },
        roomLabels: { type: "number" },
        doorTags: { type: "number" },
        windowTags: { type: "number" },
        dimensionStrings: { type: "number" }
      },
      required: [
        "titleBlocks",
        "northArrows",
        "scaleBars",
        "roomLabels",
        "doorTags",
        "windowTags",
        "dimensionStrings"
      ]
    },
    warnings: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: [
    "page",
    "sheetNumber",
    "title",
    "scale",
    "confidence",
    "status",
    "notes",
    "detectedElementCounts",
    "warnings"
  ]
};

const sheetExtractionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sheet_id: { type: "string" },
    title: { type: "string" },
    building: { type: "string" },
    source_pages: { type: "array", items: { type: "number" } },
    scale_main: { type: ["string", "null"] },
    scale_secondary: { type: ["string", "null"] },
    extraction_confidence: { type: "number", minimum: 0, maximum: 100 },
    overall_dimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        total_width: { type: ["string", "null"] },
        total_depth: { type: ["string", "null"] },
        top_chain_row1: { type: "array", items: { type: "string" } },
        top_chain_row2: { type: "array", items: { type: "string" } },
        bottom_chain: { type: "array", items: { type: "string" } },
        left_vertical_chain: { type: "array", items: { type: "string" } },
        right_vertical_chain: { type: "array", items: { type: "string" } }
      },
      required: [
        "total_width",
        "total_depth",
        "top_chain_row1",
        "top_chain_row2",
        "bottom_chain",
        "left_vertical_chain",
        "right_vertical_chain"
      ]
    },
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          room_name: { type: ["string", "null"] },
          dimensions: { type: ["string", "null"] },
          area: { type: ["string", "null"] },
          door_tags: { type: "array", items: { type: "string" } },
          window_tags: { type: "array", items: { type: "string" } },
          safety_devices: { type: "array", items: { type: "string" } },
          notes: { type: "string" }
        },
        required: ["label", "room_name", "dimensions", "area", "door_tags", "window_tags", "safety_devices", "notes"]
      }
    },
    stairs: { type: "array", items: { type: "object", additionalProperties: true } },
    door_tags_found: { type: "array", items: { type: "string" } },
    window_tags_found: { type: "array", items: { type: "string" } },
    structural_notes: { type: "array", items: { type: "string" } },
    annotations: { type: "array", items: { type: "string" } },
    fenestration_spec: {
      type: "object",
      additionalProperties: false,
      properties: {
        glazing_type: { type: ["string", "null"] },
        u_value: { type: ["string", "null"] },
        shgc_minimum: { type: ["string", "null"] },
        code_table: { type: ["string", "null"] },
        climate_zone: { type: ["string", "null"] },
        elements: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      required: ["glazing_type", "u_value", "shgc_minimum", "code_table", "climate_zone", "elements"]
    },
    floor_levels: { type: "array", items: { type: "object", additionalProperties: true } },
    site_data: { type: ["object", "null"], additionalProperties: true },
    project_metadata: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_number: { type: ["string", "null"] },
        date: { type: ["string", "null"] },
        designer: { type: ["string", "null"] },
        designer_address: { type: ["string", "null"] },
        designer_phone: { type: ["string", "null"] },
        designer_email: { type: ["string", "null"] },
        client: { type: ["string", "null"] },
        client_address: { type: ["string", "null"] },
        code_compliance: { type: ["string", "null"] }
      },
      required: [
        "project_number",
        "date",
        "designer",
        "designer_address",
        "designer_phone",
        "designer_email",
        "client",
        "client_address",
        "code_compliance"
      ]
    },
    completeness_check: {
      type: "object",
      additionalProperties: false,
      properties: {
        expected_dimension_strings: { type: "number" },
        extracted_dimension_strings: { type: "number" },
        expected_door_tags: { type: "number" },
        extracted_door_tags: { type: "number" },
        expected_window_tags: { type: "number" },
        extracted_window_tags: { type: "number" },
        missing_count: { type: "number" },
        completeness_pct: { type: "number" }
      },
      required: [
        "expected_dimension_strings",
        "extracted_dimension_strings",
        "expected_door_tags",
        "extracted_door_tags",
        "expected_window_tags",
        "extracted_window_tags",
        "missing_count",
        "completeness_pct"
      ]
    },
    low_confidence_items: { type: "array", items: { type: "string" } },
    extraction_notes: { type: "array", items: { type: "string" } }
  },
  required: [
    "sheet_id",
    "title",
    "building",
    "source_pages",
    "scale_main",
    "scale_secondary",
    "extraction_confidence",
    "overall_dimensions",
    "units",
    "stairs",
    "door_tags_found",
    "window_tags_found",
    "structural_notes",
    "annotations",
    "fenestration_spec",
    "floor_levels",
    "site_data",
    "project_metadata",
    "completeness_check",
    "low_confidence_items",
    "extraction_notes"
  ]
};

function getToolInput(payload: { content?: ClaudeContentBlock[] }, toolName: string) {
  const toolUse = payload.content?.find(
    (block): block is Extract<ClaudeContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === toolName
  );

  return toolUse?.input;
}

function getSheetType(sheetId: string) {
  const id = sheetId.toUpperCase();
  if (id.startsWith("A104") || id.startsWith("A105")) return "elevation";
  if (id.startsWith("A106") || id.startsWith("S")) return "section/structural";
  if (id.startsWith("SITE") || id.startsWith("SP")) return "site plan";
  if (id.startsWith("A2")) return "elevation";
  if (id.startsWith("A1")) return "floor plan";
  return "architectural";
}

function buildExtractionPrompt(sheet: SplitSheet) {
  const scaleNote =
    sheet.metadata.scale_main === "As Indicated"
      ? "NOTE: This sheet has multiple scales. Tag each dimension with which plan view it belongs to."
      : `Scale: ${sheet.metadata.scale_main ?? "unknown"}`;

  return `Extract ALL data from this ${getSheetType(sheet.id)} architectural drawing sheet.
Sheet: ${sheet.id} - ${sheet.title} (${sheet.building})
${scaleNote}

The sheet splitter detected approximately:
- Dimension strings: ${sheet.detected_elements.dimension_strings}
- Door tags: ${sheet.detected_elements.door_tags}
- Window tags: ${sheet.detected_elements.window_tags}
- Room labels: ${sheet.detected_elements.room_labels}

Try to match or exceed these counts. If you find fewer, do a second pass on dense areas.

Fill in every field you can read from the drawing.
For floor plans: extract every room with label, dimensions, door tags, closet sizes, safety devices.
For elevations: extract all floor level heights, overall height, roof pitch, cladding callouts.
For sections: extract floor-to-floor heights, ceiling heights, insulation specs, foundation depth.
For site plans: extract setbacks, lot dimensions, FAR tables, parking dimensions, building footprint.
For dimension chains: capture every number in order left-to-right and top-to-bottom.
Record the final extraction with the record_sheet_extraction tool.`;
}

function pageRangeLabel(pages: number[]) {
  if (pages.length === 1) return `page ${pages[0]}`;
  return `pages ${pages[0]}-${pages[pages.length - 1]}`;
}

function safeSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sheetFolderName(sheet: SplitSheet, index: number) {
  const id = safeSlug(sheet.id || `sheet-${index + 1}`) || `sheet-${index + 1}`;
  const title = safeSlug(sheet.title || "untitled");
  return `${String(index + 1).padStart(3, "0")}-${id}${title ? `-${title}` : ""}`;
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function latestRunDir() {
  return join(OUTPUT_ROOT, "latest");
}

async function sortedPageImages(runDir: string) {
  const pagesDir = join(runDir, "pages");
  const files = await readdir(pagesDir);

  return files
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort((a, b) => {
      const aPage = Number(a.match(/(\d+)\.(png|jpe?g|webp)$/i)?.[1] ?? 0);
      const bPage = Number(b.match(/(\d+)\.(png|jpe?g|webp)$/i)?.[1] ?? 0);
      return aPage - bPage;
    })
    .map((file) => join(pagesDir, file));
}

function mergeStatus(statuses: Array<Sheet["status"]>): Sheet["status"] {
  if (statuses.includes("review")) return "review";
  if (statuses.includes("warning")) return "warning";
  return "ready";
}

function buildHandoff(pageResults: PageSheetMetadata[], sheets: SplitSheet[]) {
  const reviewSheets = sheets.filter((sheet) => sheet.status !== "ready").map((sheet) => sheet.id);
  const denseSheets = pageResults
    .filter((page) => page.detectedElementCounts.dimensionStrings > 20 || page.detectedElementCounts.roomLabels > 20)
    .map((page) => page.sheetNumber);

  return {
    visionExtractor: Array.from(new Set([...sheets.map((sheet) => sheet.id), ...denseSheets])).filter(Boolean),
    textExtractor: Array.from(new Set(pageResults.map((page) => page.sheetNumber))).filter(Boolean),
    crossSheetRisks: reviewSheets.length
      ? reviewSheets.map((id) => `${id} needs confirmation before downstream checks.`)
      : ["No obvious sheet split risks found in this pass."]
  };
}

function stitchPages(pageResults: PageSheetMetadata[]) {
  const ordered = [...pageResults].sort((a, b) => a.page - b.page);
  const groups: PageSheetMetadata[][] = [];

  for (const page of ordered) {
    const previousGroup = groups[groups.length - 1];
    const previousPage = previousGroup?.[previousGroup.length - 1];
    const sameSheet =
      previousPage &&
      previousPage.sheetNumber === page.sheetNumber &&
      !page.sheetNumber.toUpperCase().startsWith("UNKNOWN");

    if (sameSheet && previousGroup) {
      previousGroup.push(page);
    } else {
      groups.push([page]);
    }
  }

  const seenSheetIds = new Map<string, number>();
  for (const group of groups) {
    const id = group[0].sheetNumber;
    seenSheetIds.set(id, (seenSheetIds.get(id) ?? 0) + 1);
  }

  const sheets = groups.map((group): SplitSheet => {
    const first = group[0];
    const pages = group.map((page) => page.page);
    const duplicateCount = seenSheetIds.get(first.sheetNumber) ?? 0;
    const warnings = group.flatMap((page) => page.warnings);
    const status = duplicateCount > 1 ? "review" : mergeStatus(group.map((page) => page.status));
    const confidence = Math.round(group.reduce((sum, page) => sum + page.confidence, 0) / group.length);
    const detectedElements = group.reduce(
      (totals, page) => ({
        dimension_strings: totals.dimension_strings + page.detectedElementCounts.dimensionStrings,
        door_tags: totals.door_tags + page.detectedElementCounts.doorTags,
        window_tags: totals.window_tags + page.detectedElementCounts.windowTags,
        room_labels: totals.room_labels + page.detectedElementCounts.roomLabels
      }),
      { dimension_strings: 0, door_tags: 0, window_tags: 0, room_labels: 0 }
    );
    const notes = [
      first.notes,
      first.scale && first.scale !== "UNKNOWN" ? `Scale: ${first.scale}.` : "",
      duplicateCount > 1 ? "Duplicate sheet number appears in non-consecutive pages." : "",
      ...warnings
    ]
      .filter(Boolean)
      .join(" ");

    return {
      id: first.sheetNumber,
      title: first.title,
      range: pageRangeLabel(pages),
      confidence,
      status,
      notes,
      pages,
      building: "Unknown",
      metadata: {
        scale_main: first.scale === "UNKNOWN" ? null : first.scale,
        scale_secondary: null
      },
      detected_elements: detectedElements
    };
  });

  const needsReview = sheets.filter((sheet) => sheet.status !== "ready").length;

  return {
    summary: {
      sheetCount: sheets.length,
      needsReview,
      notes: `Rasterized ${ordered.length} PDF page${ordered.length === 1 ? "" : "s"} and stitched consecutive matching sheet numbers into ${sheets.length} sheet entr${sheets.length === 1 ? "y" : "ies"}.`
    },
    sheets,
    handoff: buildHandoff(ordered, sheets),
    pages: ordered
  };
}

async function rasterizePdf(pdfPath: string, outputPrefix: string, dpi: number) {
  const lambdaUrl = pdfLambdaUrl();

  if (lambdaUrl) {
    return await rasterizePdfWithLambda(pdfPath, outputPrefix, dpi, lambdaUrl);
  }

  if (isHostedRuntime()) {
    throw new Error(
      "Missing PDF_LAMBDA_URL in the hosted app environment. Add your Lambda Function URL to Amplify environment variables, redeploy, and confirm amplify.yml writes it into .env.production."
    );
  }

  try {
    await execFileAsync("pdftoppm", ["-png", "-r", String(dpi), pdfPath, outputPrefix]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not run pdftoppm.";
    throw new Error(`Poppler is required to split PDFs into page images. Install it with "brew install poppler". ${message}`);
  }

  const directory = outputPrefix.slice(0, outputPrefix.lastIndexOf("/"));
  const files = await readdir(directory);

  return files
    .filter((file) => file.startsWith("page-") && file.endsWith(".png"))
    .sort((a, b) => {
      const aPage = Number(a.match(/-(\d+)\.png$/)?.[1] ?? 0);
      const bPage = Number(b.match(/-(\d+)\.png$/)?.[1] ?? 0);
      return aPage - bPage;
    })
    .map((file) => join(directory, file));
}

function pdfLambdaUrl() {
  return (
    process.env.PDF_LAMBDA_URL ||
    process.env.NEXT_SERVER_PDF_LAMBDA_URL ||
    process.env.NEXT_PUBLIC_PDF_LAMBDA_URL ||
    process.env.PDF_SPLITTER_URL ||
    ""
  ).trim();
}

function isHostedRuntime() {
  return Boolean(
    process.env.AWS_BRANCH ||
      process.env.AWS_APP_ID ||
      process.env.AMPLIFY_APP_ID ||
      process.env.AWS_EXECUTION_ENV ||
      process.env.NODE_ENV === "production"
  );
}

function normalizeLambdaPayload(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === "object" &&
    "body" in payload &&
    typeof (payload as { body?: unknown }).body === "string"
  ) {
    try {
      return JSON.parse((payload as { body: string }).body);
    } catch {
      return payload;
    }
  }

  return payload;
}

function lambdaPageItems(payload: unknown) {
  const normalized = normalizeLambdaPayload(payload);

  if (Array.isArray(normalized)) return normalized;
  if (!normalized || typeof normalized !== "object") return [];

  const objectPayload = normalized as Record<string, unknown>;
  const candidateKeys = ["pages", "pageImages", "images", "files"];

  for (const key of candidateKeys) {
    const value = objectPayload[key];
    if (Array.isArray(value)) return value;
  }

  return [];
}

function lambdaPayloadSummary(payload: unknown) {
  const normalized = normalizeLambdaPayload(payload);

  if (!normalized || typeof normalized !== "object") {
    return `response type: ${typeof normalized}`;
  }

  const objectPayload = normalized as Record<string, unknown>;
  const keys = Object.keys(objectPayload);
  const message = typeof objectPayload.message === "string" ? ` message: ${objectPayload.message}` : "";

  return `keys: ${keys.length ? keys.join(", ") : "none"}.${message}`;
}

function pageBase64FromLambdaItem(item: unknown) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";

  const objectItem = item as Record<string, unknown>;
  const value =
    objectItem.imageBase64 ??
    objectItem.base64 ??
    objectItem.data ??
    objectItem.content ??
    objectItem.body;

  return typeof value === "string" ? value : "";
}

function pageMediaTypeFromLambdaItem(item: unknown) {
  if (!item || typeof item !== "object") return "image/png";

  const objectItem = item as Record<string, unknown>;
  const value = objectItem.mediaType ?? objectItem.mimeType ?? objectItem.contentType;

  return typeof value === "string" && value.startsWith("image/") ? value : "image/png";
}

function extensionForMediaType(mediaType: string) {
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

function stripDataUrlPrefix(value: string) {
  return value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
}

async function pageBytesFromLambdaItem(item: unknown) {
  if (item && typeof item === "object") {
    const objectItem = item as Record<string, unknown>;
    const url =
      objectItem.url ??
      objectItem.signedUrl ??
      objectItem.presignedUrl ??
      objectItem.downloadUrl ??
      objectItem.s3Url;

    if (typeof url === "string" && url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`PDF Lambda returned an image URL that could not be downloaded: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    }
  }

  const base64 = stripDataUrlPrefix(pageBase64FromLambdaItem(item)).trim();
  if (!base64) return null;

  return Buffer.from(base64, "base64");
}

async function rasterizePdfWithLambda(pdfPath: string, outputPrefix: string, dpi: number, lambdaUrl: string) {
  const directory = outputPrefix.slice(0, outputPrefix.lastIndexOf("/"));
  await mkdir(directory, { recursive: true });

  const pdfBytes = await readFile(pdfPath);

  const response = await fetch(lambdaUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      filename: basename(pdfPath),
      dpi,
      pdfBase64: pdfBytes.toString("base64")
    })
  });
  const responseText = await response.text();
  let payload: unknown;

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`PDF Lambda returned non-JSON response: ${responseText.slice(0, 180)}`);
  }

  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : responseText;
    throw new Error(`PDF Lambda failed: ${errorMessage}`);
  }

  const pages = lambdaPageItems(payload);
  if (!pages.length) {
    throw new Error(
      `PDF Lambda did not return page images. Expected pages, pageImages, images, or files array. Lambda returned ${lambdaPayloadSummary(payload)}`
    );
  }

  const pageImages: string[] = [];

  for (let index = 0; index < pages.length; index += 1) {
    const item = pages[index];
    const bytes = await pageBytesFromLambdaItem(item);

    if (!bytes?.length) {
      throw new Error(`PDF Lambda page ${index + 1} did not include base64 image data or a downloadable URL.`);
    }

    const mediaType = pageMediaTypeFromLambdaItem(item);
    const outputPath = join(
      directory,
      `page-${String(index + 1).padStart(3, "0")}.${extensionForMediaType(mediaType)}`
    );
    await writeFile(outputPath, bytes);
    pageImages.push(outputPath);
  }

  return pageImages;
}

async function analyzePage({
  apiKey,
  imagePath,
  page,
  dpi
}: {
  apiKey: string;
  imagePath: string;
  page: number;
  dpi: number;
}) {
  const imageBase64 = (await readFile(imagePath)).toString("base64");
  const mediaType = imageMediaType(imagePath);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      tools: [
        {
          name: "record_page_sheet_metadata",
          description: "Record detected permit plan sheet metadata from one rasterized PDF page.",
          input_schema: pageMetadataSchema
        }
      ],
      tool_choice: {
        type: "tool",
        name: "record_page_sheet_metadata"
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: imageBase64
              }
            },
            {
              type: "text",
              text: `This is PDF page ${page}, rasterized at ${dpi} DPI. Identify the sheet number, title, scale, confidence, notable element counts, and split warnings.`
            }
          ]
        }
      ]
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Claude API failed on page ${page}.`);
  }

  const input = getToolInput(payload, "record_page_sheet_metadata");
  if (!input || typeof input !== "object") {
    throw new Error(`Claude did not return structured metadata for page ${page}.`);
  }

  return { ...(input as PageSheetMetadata), page };
}

function imageExtension(imagePath: string) {
  const lower = imagePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpg";
  if (lower.endsWith(".webp")) return "webp";
  return "png";
}

function imageMediaType(imagePath: string) {
  const extension = imageExtension(imagePath);
  if (extension === "jpg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "image/png";
}

function responseTextFromClaude(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";

  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function savedPageFiles() {
  const pagesDir = join(latestRunDir(), "pages");
  const files = await readdir(pagesDir);

  return files
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort((first, second) => {
      const firstPage = Number(first.match(/(\d+)\.(png|jpe?g|webp)$/i)?.[1] ?? 0);
      const secondPage = Number(second.match(/(\d+)\.(png|jpe?g|webp)$/i)?.[1] ?? 0);
      return firstPage - secondPage;
    });
}

function pageNumberFromValue(value: string) {
  const match = value.match(/(\d+)/);
  const pageNumber = Number(match?.[1] ?? 3);
  return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 3;
}

function pageSlug(pageNumber: number) {
  return `page-${String(pageNumber).padStart(2, "0")}`;
}

async function resolveLocalPageImage(pageValue: string) {
  const pagesDir = join(latestRunDir(), "pages");
  const files = await savedPageFiles();
  const pageNumber = pageNumberFromValue(pageValue);
  const pageFile =
    files.find((file) => new RegExp(`^page-0*${pageNumber}\\.(png|jpe?g|webp)$`, "i").test(file)) ??
    files.find((file) => new RegExp(`(^|-)0*${pageNumber}\\.(png|jpe?g|webp)$`, "i").test(file));

  if (!pageFile) {
    throw new Error(`Could not find saved page ${pageNumber} in output/latest/pages.`);
  }

  return {
    imagePath: join(pagesDir, pageFile),
    page: pageSlug(pageNumber)
  };
}

async function listSavedPages() {
  const pagesDir = join(latestRunDir(), "pages");
  const files = await savedPageFiles();

  return NextResponse.json({
    savedPages: files.map((file) => {
      const pageNumber = pageNumberFromValue(file);
      return {
        value: pageSlug(pageNumber),
        label: `Page ${pageNumber}`,
        imagePath: join(pagesDir, file)
      };
    })
  });
}

async function runPagePlanCheck(apiKey: string, pageValue: string) {
  const { imagePath, page } = await resolveLocalPageImage(pageValue);
  const skillBody = await readFile(BCBC_2024_SKILL_PATH, "utf8");
  const imageBase64 = (await readFile(imagePath)).toString("base64");
  const mediaType = imageMediaType(imagePath);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system:
        "You are a municipal plans examiner. Use the supplied BCBC 2024 skill reference as the controlling code source. Return only the plan-check report requested by the user.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: imageBase64
              }
            },
            {
              type: "text",
              text: `${BCBC_PAGE_CHECK_PROMPT}\n\n---\n\nBCBC 2024 SKILL REFERENCE FILE:\n\n${skillBody}\n\n---\n\nReview this uploaded image. The local file is ${imagePath}.`
            }
          ]
        }
      ]
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Claude ${page} plan check failed.`);
  }

  const report = responseTextFromClaude(payload);
  if (!report) {
    throw new Error("Claude did not return a text plan-check report.");
  }

  const outputPath = join(latestRunDir(), `${page}-bcbc-plan-check.md`);
  await writeFile(outputPath, report);

  return NextResponse.json({
    pagePlanCheck: {
      page,
      imagePath,
      skillPath: BCBC_2024_SKILL_PATH,
      outputPath,
      report
    }
  });
}

async function loadSavedPagePlanCheck(pageValue: string) {
  const { imagePath, page } = await resolveLocalPageImage(pageValue);
  const outputPath = join(latestRunDir(), `${page}-bcbc-plan-check.md`);
  const report = await readFile(outputPath, "utf8");

  return NextResponse.json({
    pagePlanCheck: {
      page,
      imagePath,
      skillPath: BCBC_2024_SKILL_PATH,
      outputPath,
      report
    }
  });
}

async function extractSheet({
  apiKey,
  sheet,
  pageImages
}: {
  apiKey: string;
  sheet: SplitSheet;
  pageImages: string[];
}) {
  const imageContent = await Promise.all(
    sheet.pages.map(async (pageNumber) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: imageMediaType(pageImages[pageNumber - 1]),
        data: (await readFile(pageImages[pageNumber - 1])).toString("base64")
      }
    }))
  );

  const contextNote =
    sheet.pages.length > 1
      ? [
          {
            type: "text" as const,
            text: `Note: This sheet spans ${sheet.pages.length} pages shown above. Extract data from all pages as one sheet.`
          }
        ]
      : [];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: BASE_SYSTEM,
      tools: [
        {
          name: "record_sheet_extraction",
          description: "Record full structured extraction from one split architectural drawing sheet.",
          input_schema: sheetExtractionSchema
        }
      ],
      tool_choice: {
        type: "tool",
        name: "record_sheet_extraction"
      },
      messages: [
        {
          role: "user",
          content: [
            ...imageContent,
            ...contextNote,
            {
              type: "text",
              text: buildExtractionPrompt(sheet)
            }
          ]
        }
      ]
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Claude extraction failed for ${sheet.id}.`);
  }

  const input = getToolInput(payload, "record_sheet_extraction");
  if (!input || typeof input !== "object") {
    throw new Error(`Claude did not return structured extraction for ${sheet.id}.`);
  }

  return input;
}

async function saveSplitArtifacts({
  file,
  dpi,
  pdfPath,
  workspace,
  pageImages,
  splitResult,
  extracted
}: {
  file: File;
  dpi: number;
  pdfPath: string;
  workspace: string;
  pageImages: string[];
  splitResult: SplitResult;
  extracted?: unknown[];
}) {
  const runSlug = `${safeSlug(file.name) || "plan-set"}-${timestampSlug()}`;
  const runDir = join(OUTPUT_ROOT, runSlug);
  const pagesDir = join(runDir, "pages");
  const sheetsDir = join(runDir, "sheets");
  const extractedDir = join(runDir, "extracted");
  const pagePdfPattern = join(workspace, "pdf-page-%03d.pdf");
  let pagePdfsAvailable = true;

  await mkdir(pagesDir, { recursive: true });
  await mkdir(sheetsDir, { recursive: true });
  await mkdir(extractedDir, { recursive: true });

  try {
    await execFileAsync("pdfseparate", [pdfPath, pagePdfPattern]);
  } catch {
    pagePdfsAvailable = false;
  }

  await Promise.all(
    pageImages.map((imagePath, index) =>
      copyFile(
        imagePath,
        join(pagesDir, `page-${String(index + 1).padStart(3, "0")}.${imageExtension(imagePath)}`)
      )
    )
  );

  await writeFile(
    join(runDir, "sheets.json"),
    JSON.stringify(
      {
        source_file: file.name,
        dpi,
        saved_at: new Date().toISOString(),
        summary: splitResult.summary,
        sheets: splitResult.sheets,
        handoff: splitResult.handoff,
        pages: splitResult.pages
      },
      null,
      2
    )
  );

  await Promise.all(
    splitResult.sheets.map(async (sheet, index) => {
      const sheetDir = join(sheetsDir, sheetFolderName(sheet, index));
      await mkdir(sheetDir, { recursive: true });
      await writeFile(join(sheetDir, "sheet.json"), JSON.stringify(sheet, null, 2));

      await Promise.all(
        sheet.pages.map((pageNumber) =>
          copyFile(
            pageImages[pageNumber - 1],
            join(
              sheetDir,
              `page-${String(pageNumber).padStart(3, "0")}.${imageExtension(pageImages[pageNumber - 1])}`
            )
          )
        )
      );

      if (pagePdfsAvailable) {
        const pagePdfs = sheet.pages.map((pageNumber) => join(workspace, `pdf-page-${String(pageNumber).padStart(3, "0")}.pdf`));

        try {
          await execFileAsync("pdfunite", [...pagePdfs, join(sheetDir, "sheet.pdf")]);
        } catch {
          await writeFile(
            join(sheetDir, "sheet-pdf-note.txt"),
            "Sheet PDF was not created because pdfunite is unavailable in this runtime."
          );
        }
      } else {
        await writeFile(
          join(sheetDir, "sheet-pdf-note.txt"),
          "Sheet PDF was not created because pdfseparate is unavailable in this runtime."
        );
      }
    })
  );

  if (extracted) {
    await saveExtractionArtifacts({ runDir, splitResult, extracted, sourceFile: file.name, dpi });
  }

  const latestDir = join(OUTPUT_ROOT, "latest");
  await rm(latestDir, { recursive: true, force: true });

  try {
    await symlink(runDir, latestDir, "dir");
  } catch {
    await cp(runDir, latestDir, { recursive: true });
  }

  return {
    runDir,
    relativeRunDir: join("output", basename(runDir)),
    latestDir
  };
}

async function saveExtractionArtifacts({
  runDir,
  splitResult,
  extracted,
  sourceFile,
  dpi
}: {
  runDir: string;
  splitResult: SplitResult;
  extracted: unknown[];
  sourceFile: string;
  dpi: number;
}) {
  const extractedDir = join(runDir, "extracted");
  await mkdir(extractedDir, { recursive: true });

  await Promise.all(
    extracted.map((item, index) => {
      const sheet = splitResult.sheets[index];
      const filename = `${sheetFolderName(sheet, index)}.json`;
      return writeFile(join(extractedDir, filename), JSON.stringify(item, null, 2));
    })
  );

  await writeFile(
    join(runDir, "extraction-manifest.json"),
    JSON.stringify(
      {
        extracted_at: new Date().toISOString(),
        source_file: sourceFile,
        dpi,
        sheet_count: splitResult.sheets.length,
        extracted_count: extracted.length,
        output_dir: runDir
      },
      null,
      2
    )
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  callback: (item: T, index: number) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await callback(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toClientPayload({
  splitResult,
  artifacts,
  extracted,
  precheck,
  dimensions,
  roomMeasurements,
  openings
}: {
  splitResult: SplitResult;
  artifacts?: { runDir: string; relativeRunDir: string; latestDir: string };
  extracted?: unknown[];
  precheck?: {
    summary: {
      blockerCount: number;
      warningCount: number;
      infoCount: number;
      notes: string;
    };
    issues: PrecheckIssue[];
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
}) {
  return {
    ...splitResult,
    ...(artifacts ? { artifacts } : {}),
    ...(extracted
      ? {
          extraction: {
            summary: {
              extractedSheets: extracted.length,
              notes: "Vision extractor ran on saved split sheets and returned structured architectural data."
            },
            sheets: extracted
          }
        }
      : {}),
    ...(precheck ? { precheck } : {}),
    ...(dimensions ? { dimensions } : {}),
    ...(roomMeasurements ? { roomMeasurements } : {}),
    ...(openings ? { openings } : {})
  };
}

async function loadLatestSplit() {
  const runDir = latestRunDir();
  const sheetsData = await readJson<{
    source_file?: string;
    dpi?: number;
    summary: SplitResult["summary"];
    sheets: SplitSheet[];
    handoff: SplitResult["handoff"];
    pages: PageSheetMetadata[];
  }>(join(runDir, "sheets.json"));

  return {
    runDir,
    sourceFile: sheetsData.source_file ?? "saved-plan-set.pdf",
    dpi: sheetsData.dpi ?? DEFAULT_DPI,
    splitResult: {
      summary: sheetsData.summary,
      sheets: sheetsData.sheets,
      handoff: sheetsData.handoff,
      pages: sheetsData.pages
    }
  };
}

async function splitPdfInWorkspace({
  file,
  dpi,
  apiKey,
  workspace
}: {
  file: File;
  dpi: number;
  apiKey: string;
  workspace: string;
}) {
  const pdfPath = join(workspace, "input.pdf");
  await writeFile(pdfPath, Buffer.from(await file.arrayBuffer()));

  const pageImages = await rasterizePdf(pdfPath, join(workspace, "page"), dpi);

  if (!pageImages.length) {
    throw new Error("No pages were produced from the PDF.");
  }

  const pageResults = await mapWithConcurrency(pageImages, PAGE_CONCURRENCY, (imagePath, index) =>
    analyzePage({
      apiKey,
      imagePath,
      page: index + 1,
      dpi
    })
  );

  return {
    pdfPath,
    pageImages,
    splitResult: stitchPages(pageResults)
  };
}

async function runSplitOnly({
  file,
  dpi,
  apiKey
}: {
  file: File;
  dpi: number;
  apiKey: string;
}) {
  const workspace = await mkdtemp(join(tmpdir(), "sheet-splitter-"));

  try {
    const { pdfPath, pageImages, splitResult } = await splitPdfInWorkspace({ file, dpi, apiKey, workspace });
    const artifacts = await saveSplitArtifacts({
      file,
      dpi,
      pdfPath,
      workspace,
      pageImages,
      splitResult
    });

    return NextResponse.json(toClientPayload({ splitResult, artifacts }));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runExtractionOnly(apiKey: string) {
  const { runDir, sourceFile, dpi, splitResult } = await loadLatestSplit();
  const pageImages = await sortedPageImages(runDir);

  if (!pageImages.length) {
    return NextResponse.json({ error: "No saved page images found in output/latest/pages." }, { status: 422 });
  }

  const extracted = await mapWithConcurrency(splitResult.sheets, SHEET_EXTRACTION_CONCURRENCY, (sheet) =>
    extractSheet({
      apiKey,
      sheet,
      pageImages
    })
  );

  await saveExtractionArtifacts({ runDir, splitResult, extracted, sourceFile, dpi });

  return NextResponse.json(
    toClientPayload({
      splitResult,
      artifacts: {
        runDir,
        relativeRunDir: join("output", basename(runDir)),
        latestDir: latestRunDir()
      },
      extracted
    })
  );
}

async function runFullReportOnTheFly({
  file,
  dpi,
  apiKey
}: {
  file: File;
  dpi: number;
  apiKey: string;
}) {
  const workspace = await mkdtemp(join(tmpdir(), "permit-precheck-"));

  try {
    const { pdfPath, pageImages, splitResult } = await splitPdfInWorkspace({ file, dpi, apiKey, workspace });
    const extracted = (await mapWithConcurrency(splitResult.sheets, SHEET_EXTRACTION_CONCURRENCY, (sheet) =>
      extractSheet({
        apiKey,
        sheet,
        pageImages
      })
    )) as Array<Record<string, unknown>>;
    const sources = extractionSources(splitResult);
    const roomMeasurements = buildRoomMeasurementReport(extracted, sources);
    const openings = buildOpeningReport(extracted, sources);
    const dimensions = buildDimensionReport(extracted);
    const precheck = buildPrecheckReport(extracted);
    const artifacts = await saveSplitArtifacts({
      file,
      dpi,
      pdfPath,
      workspace,
      pageImages,
      splitResult,
      extracted
    });

    return NextResponse.json(
      toClientPayload({
        splitResult,
        artifacts,
        extracted,
        roomMeasurements,
        openings,
        dimensions,
        precheck
      })
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }

  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
  } catch {
    const rooms: Record<string, unknown>[] = [];
    const blocks = value.match(/\{[\s\S]*?\}/g) ?? [];

    for (const block of blocks) {
      const roomName = block.match(/"(?:room_name|label)"\s*:\s*"([^"]+)"/)?.[1];
      const dimensions = block.match(/"dimensions"\s*:\s*(null|"[^"]*(?:""|'')[^"]*"|"[^"]*")/)?.[1];
      const normalizedDimensions = dimensions && dimensions !== "null" ? cleanDimensionText(dimensions) : null;

      if (roomName) {
        rooms.push({
          room_name: roomName,
          label: roomName,
          dimensions: normalizedDimensions
        });
      }
    }

    return rooms;
  }

  return [];
}

function cleanDimensionText(value: string) {
  let text = value.trim().split(/\r?\n/)[0].trim().replace(/,$/, "").trim();
  if (text === "null") return "";

  text = text.replace(/^"+/, "");
  const hasTrailingInchMark = /"+$/.test(text);
  text = text.replace(/"+$/, "");

  return hasTrailingInchMark ? `${text}"` : text;
}

function inferPrecheckSheetType(sheet: Record<string, unknown>) {
  const sheetId = stringValue(sheet.sheet_id).toUpperCase();
  const title = stringValue(sheet.title).toUpperCase();
  const unitsCount = arrayLength(sheet.units);
  const floorLevelsCount = arrayLength(sheet.floor_levels);
  const structuralNotesCount = arrayLength(sheet.structural_notes);
  const hasSiteData = Boolean(sheet.site_data);

  if (sheetId.includes("SITE") || title.includes("SITE") || hasSiteData) return "site";
  if (sheetId.startsWith("UNKNOWN") || title.includes("DETAIL")) return "detail";
  if (title.includes("ELEVATION") || sheetId.startsWith("A104") || sheetId.startsWith("A105") || sheetId.startsWith("A2")) {
    return "elevation";
  }
  if (title.includes("SECTION") || sheetId.startsWith("A106") || sheetId.startsWith("S") || structuralNotesCount > 20) {
    return "section";
  }
  if (unitsCount > 0 || title.includes("FLOOR") || title.includes("ROOF PLATE") || /^A10[1-3]/.test(sheetId)) {
    return "floor-plan";
  }

  if (floorLevelsCount > 0) return "elevation";
  return "architectural";
}

function inferDimensionSheetType(sheet: Record<string, unknown>) {
  const sheetId = stringValue(sheet.sheet_id).toUpperCase();
  const title = stringValue(sheet.title).toUpperCase();
  const structuralNotesCount = arrayLength(sheet.structural_notes);

  if (title.includes("ELEVATION") || sheetId.startsWith("A104") || sheetId.startsWith("A105")) return "elevation";
  if (title.includes("SECTION") || sheetId.startsWith("A106") || structuralNotesCount > 20) return "section";
  if (title.includes("FLOOR") || title.includes("ROOF PLATE") || /^A10[1-3]/.test(sheetId)) return "floor-plan";
  if (sheetId.includes("SITE") || title.includes("SITE") || sheetId === "12629") return "site";
  if (sheetId.startsWith("UNKNOWN") || title.includes("DETAIL")) return "detail";

  return inferPrecheckSheetType(sheet);
}

function normalizeText(value: unknown) {
  return stringValue(value).trim();
}

function roomLabel(room: Record<string, unknown>, index: number) {
  return normalizeText(room.room_name) || normalizeText(room.label) || `Room ${index + 1}`;
}

function isDimensionReviewRoom(label: string) {
  const upper = label.toUpperCase().trim();

  if (!upper) return false;
  if (/^AREA\d*$/i.test(label.trim()) || upper === "AREA") return false;
  if (upper.includes("BUILDING PLAN REFERENCE")) return false;
  if (upper.includes("SECOND BUILDING REFERENCE")) return false;
  if (upper === "STREET" || upper.includes("AVENUE") || upper.includes("LANE")) return false;
  if (upper === "D/W" || upper === "ROOF PLATE" || upper.includes("WALL")) return false;
  if (upper.includes("BENCH") || upper.includes("CUBBIES")) return false;

  return true;
}

function doorMinimumForRoom(label: string) {
  const upper = label.toUpperCase();

  if (upper.includes("ENTRY") || upper.includes("VESTIBULE") || upper.includes("ENTRANCE")) {
    return {
      width: 810,
      height: 1980,
      category: "dwelling unit entrance / vestibule"
    };
  }

  if (upper.includes("STAIR")) {
    return {
      width: 810,
      height: 1980,
      category: "stairs to floor level with finished space"
    };
  }

  if (upper.includes("BATH") || upper.includes("WC") || upper.includes("W/C") || upper.includes("SHOWER")) {
    return {
      width: 610,
      height: 1980,
      category: "bathroom / WC / shower room"
    };
  }

  if (upper.includes("CLOSET")) {
    return {
      width: 610,
      height: 1980,
      category: "walk-in closet"
    };
  }

  if (upper.includes("UTILITY") || upper.includes("UTILITIES") || upper.includes("BOILER") || upper.includes("LAUNDRY")) {
    return {
      width: 610,
      height: 1980,
      category: "utility / laundry room"
    };
  }

  return {
    width: 610,
    height: 1980,
    category: "rooms not mentioned above / exterior balconies"
  };
}

function classifyRoomForDimensions(label: string) {
  const upper = label.toUpperCase();
  const doorMinimum = doorMinimumForRoom(label);

  if (upper.includes("CLOSET")) return null;
  if (upper.includes("GARAGE")) {
    return {
      required: "min 2.0m clear height for storage garages",
      doorWidth: doorMinimum.width,
      doorHeight: doorMinimum.height,
      doorCategory: doorMinimum.category
    };
  }
  if (upper.includes("BATH") || upper.includes("WC") || upper.includes("W/C") || upper.includes("SHOWER")) {
    return {
      required: "min 2.1m ceiling height over min 2.2m2 area",
      doorWidth: doorMinimum.width,
      doorHeight: doorMinimum.height,
      doorCategory: doorMinimum.category
    };
  }
  if (upper.includes("LAUNDRY")) {
    return {
      required: "min 2.1m ceiling height over min 2.2m2 area",
      doorWidth: doorMinimum.width,
      doorHeight: doorMinimum.height,
      doorCategory: doorMinimum.category
    };
  }
  if (upper.includes("BED")) {
    return {
      required: "min 2.1m ceiling height over required bedroom area from Table 9.5.3.1",
      doorWidth: doorMinimum.width,
      doorHeight: doorMinimum.height,
      doorCategory: doorMinimum.category
    };
  }
  if (upper.includes("KITCHEN")) {
    return {
      required: "min 2.1m ceiling height over min 3.2m2 area",
      doorWidth: doorMinimum.width,
      doorHeight: doorMinimum.height,
      doorCategory: doorMinimum.category
    };
  }
  if (upper.includes("DINING")) {
    return {
      required: "min 2.1m ceiling height over min 5.2m2 area",
      doorWidth: doorMinimum.width,
      doorHeight: doorMinimum.height,
      doorCategory: doorMinimum.category
    };
  }
  if (upper.includes("LIVING") || upper.includes("FAMILY") || upper.includes("GREAT") || upper.includes("REC")) {
    return {
      required: "min 2.1m ceiling height over applicable room area from Table 9.5.3.1",
      doorWidth: doorMinimum.width,
      doorHeight: doorMinimum.height,
      doorCategory: doorMinimum.category
    };
  }

  return {
    required: "min 2.1m ceiling height over min 2.2m2 area for habitable rooms not listed above",
    doorWidth: doorMinimum.width,
    doorHeight: doorMinimum.height,
    doorCategory: doorMinimum.category
  };
}

function dimensionCheckId(sheetId: string, element: string, suffix: string) {
  return `${sheetId}-${element}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function decodeDoorTag(tag: string) {
  const compact = tag.replace(/[^0-9]/g, "");
  if (!/^\d{4}$/.test(compact)) return null;

  const widthFeet = Number(compact[0]);
  const widthInches = Number(compact[1]);
  const heightFeet = Number(compact[2]);
  const heightInches = Number(compact[3]);

  if (![widthFeet, widthInches, heightFeet, heightInches].every(Number.isFinite)) return null;

  const widthMm = Math.round((widthFeet * 12 + widthInches) * 25.4);
  const heightMm = Math.round((heightFeet * 12 + heightInches) * 25.4);

  return {
    widthMm,
    heightMm,
    label: `${compact} = ${widthFeet}'-${widthInches}" wide x ${heightFeet}'-${heightInches}" high (${widthMm}mm x ${heightMm}mm)`
  };
}

function pushDimensionFinding(
  findings: DimensionFinding[],
  finding: Omit<DimensionFinding, "building"> & { building?: string }
) {
  findings.push({
    ...finding,
    building: finding.building || "Fourplex"
  });
}

function runDimensionsForSheet(sheet: Record<string, unknown>) {
  const sheetId = normalizeText(sheet.sheet_id) || "UNKNOWN";
  const building = normalizeText(sheet.building) || "Fourplex";
  const sheetType = inferDimensionSheetType(sheet);
  const units =
    sheetType === "floor-plan" || sheetType === "section"
      ? objectArray(sheet.units).filter((unit, index) => isDimensionReviewRoom(roomLabel(unit, index)))
      : [];
  const findings: DimensionFinding[] = [];

  units.forEach((unit, index) => {
    const label = roomLabel(unit, index);
    const classification = classifyRoomForDimensions(label);
    const dimensions = normalizeText(unit.dimensions);
    const unitName = normalizeText(unit.unit) || normalizeText(unit.unit_id) || "Unassigned";
    const doorTags = [...textArray(unit.door_tags), ...textArray(unit.door_tags_found)];

    if (!classification) return;

    pushDimensionFinding(findings, {
      check_id: dimensionCheckId(sheetId, label, "room-dimensions"),
      bcbc_clause: "9.5.1.1",
      bcbc_table: null,
      element: label,
      sheet: sheetId,
      building,
      unit: unitName,
      extracted_value: dimensions || "not shown on this sheet",
      required_value: "dimensions measured between finished wall surfaces; flag rooms within 50mm of a minimum",
      status: dimensions ? "VERIFY" : "VERIFY",
      note: dimensions
        ? "Room dimension was extracted. Confirm it is measured to finished wall surfaces before relying on it."
        : "Room dimension was not extracted for this room.",
      downstream: "Dimensions agent"
    });

    pushDimensionFinding(findings, {
      check_id: dimensionCheckId(sheetId, label, "ceiling"),
      bcbc_clause: "9.5.3.1",
      bcbc_table: "Table 9.5.3.1",
      element: `${label} ceiling height`,
      sheet: sheetId,
      building,
      unit: unitName,
      extracted_value: sheetType === "section" ? "review section extraction for height marker" : "not shown on floor plan sheet",
      required_value: classification.required,
      status: "VERIFY",
      note:
        sheetType === "section"
          ? "Confirm clear height from section dimensions and assembly thickness."
          : "Ceiling heights are normally confirmed on section sheets, not floor plans.",
      downstream: "Structural agent / section checker"
    });

    doorTags.forEach((tag) => {
      const decoded = decodeDoorTag(tag);
      const minHeight = classification.doorHeight;
      const isLikelyOcrMisread = decoded ? decoded.widthMm < 457 || decoded.heightMm < 1829 : false;
      const status = decoded
        ? isLikelyOcrMisread
          ? "VERIFY"
          : decoded.widthMm >= classification.doorWidth && decoded.heightMm >= minHeight
            ? "PASS"
            : "FLAG"
        : "VERIFY";

      pushDimensionFinding(findings, {
        check_id: dimensionCheckId(sheetId, `${label}-${tag}`, "door"),
        bcbc_clause: "9.5.5.1",
        bcbc_table: "Table 9.5.5.1",
        element: `${label} door`,
        sheet: sheetId,
        building,
        unit: unitName,
        extracted_value: decoded ? decoded.label : `${tag} could not be decoded`,
        required_value: `min ${classification.doorWidth}mm wide x ${minHeight}mm high for ${classification.doorCategory}`,
        status,
        note:
          isLikelyOcrMisread
            ? "Decoded door size is physically unlikely, so this is probably an OCR misread. Recheck with a zoom crop before code review."
            : status === "FLAG"
            ? "Decoded door tag appears below the BCBC minimum for this location."
            : status === "PASS"
              ? ""
              : "Door tag format was not recognized. Verify clear opening size on the drawing.",
        downstream: status === "PASS" ? null : "Clarification agent"
      });
    });
  });

  const sheetDoorTags = textArray(sheet.door_tags_found);
  if (!units.length && sheetType === "floor-plan") {
    pushDimensionFinding(findings, {
      check_id: dimensionCheckId(sheetId, "rooms", "missing"),
      bcbc_clause: "9.5.1.1",
      bcbc_table: null,
      element: "Rooms and unit labels",
      sheet: sheetId,
      building,
      unit: "Unassigned",
      extracted_value: "no room/unit objects extracted",
      required_value: "room labels and dimensions required before BCBC 9.5 review",
      status: "VERIFY",
      note: "Run or improve vision extraction for this floor-plan sheet before accepting the dimension review.",
      downstream: "Vision extractor"
    });
  }

  sheetDoorTags.forEach((tag) => {
    const decoded = decodeDoorTag(tag);
    pushDimensionFinding(findings, {
      check_id: dimensionCheckId(sheetId, `${tag}`, "sheet-door"),
      bcbc_clause: "9.5.5.1",
      bcbc_table: "Table 9.5.5.1",
      element: `Door tag ${tag}`,
      sheet: sheetId,
      building,
      unit: "Unassigned",
      extracted_value: decoded ? decoded.label : `${tag} could not be decoded`,
      required_value: "compare to location-specific minimum in Table 9.5.5.1",
      status: decoded ? "VERIFY" : "VERIFY",
      note: "Door location was not attached to a room, so clear opening compliance needs a manual location check.",
      downstream: "Clarification agent"
    });
  });

  if (sheetType === "floor-plan") {
    const searchableText = JSON.stringify(sheet).toUpperCase();
    const hasHallway = searchableText.includes("HALL") || searchableText.includes("CORRIDOR");
    const hasHallWidth = /(?:HALL|CORRIDOR)[^0-9]{0,20}\d+['" -]/.test(searchableText);

    if (hasHallway || units.length) {
      pushDimensionFinding(findings, {
        check_id: dimensionCheckId(sheetId, "corridor", "width"),
        bcbc_clause: "9.5.4.1",
        bcbc_table: null,
        element: "Hallway / corridor width",
        sheet: sheetId,
        building,
        unit: hasHallway ? "Shared or unit hallway" : "Unassigned",
        extracted_value: hasHallWidth ? "possible hallway dimension detected in OCR text" : "not dimensioned on drawing",
        required_value: "min 860mm unobstructed, unless 710mm exception conditions are met",
        status: "VERIFY",
        note: hasHallWidth
          ? "Confirm the extracted hallway width and whether it is unobstructed finished width."
          : "No clear hallway width dimension was extracted.",
        downstream: "Clarification agent"
      });
    }
  }

  if (!findings.length) {
    pushDimensionFinding(findings, {
      check_id: dimensionCheckId(sheetId, "dimension-review", "not-applicable"),
      bcbc_clause: "9.5",
      bcbc_table: null,
      element: "Dimension review",
      sheet: sheetId,
      building,
      unit: "N/A",
      extracted_value: `inferred sheet type: ${sheetType}`,
      required_value: "BCBC Section 9.5 applies to room dimensions, ceiling heights, hallways, and doors",
      status: "VERIFY",
      note: "No applicable room, hallway, or door data was found in this extraction JSON.",
      downstream: "Vision extractor"
    });
  }

  return findings;
}

async function runDimensionsOnly() {
  const { runDir, splitResult } = await loadLatestSplit();
  const skillBody = await readFile(DIMENSIONS_SKILL_PATH, "utf8");
  const extractedDir = join(runDir, "extracted");
  const files = (await readdir(extractedDir)).filter((file) => file.endsWith(".json")).sort();

  if (!files.length) {
    return NextResponse.json(
      { error: "No saved extraction JSON found. Run Extract Saved Sheets first." },
      { status: 422 }
    );
  }

  const extracted = await Promise.all(files.map((file) => readJson<Record<string, unknown>>(join(extractedDir, file))));
  const dimensions = buildDimensionReport(extracted);

  await writeFile(
    join(runDir, "dimension-report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        skill: {
          name: "bcbc-dimensions",
          skill_path: DIMENSIONS_SKILL_PATH,
          loaded_skill_bytes: skillBody.length
        },
        ...dimensions
      },
      null,
      2
    )
  );

  return NextResponse.json(
    toClientPayload({
      splitResult,
      artifacts: {
        runDir,
        relativeRunDir: join("output", basename(runDir)),
        latestDir: latestRunDir()
      },
      extracted,
      dimensions
    })
  );
}

function extractRoomMeasurementsForSheet(sheet: Record<string, unknown>, source: string) {
  const sheetId = normalizeText(sheet.sheet_id) || "UNKNOWN";
  const sheetTitle = normalizeText(sheet.title) || "Untitled sheet";
  const sheetType = inferDimensionSheetType(sheet);
  const units = objectArray(sheet.units);

  if (!sheetId.toUpperCase().startsWith("A") || !["floor-plan", "section"].includes(sheetType)) {
    return [];
  }

  return units
    .map((unit, index): RoomMeasurement => {
      const roomName = roomLabel(unit, index);
      const rawDimensions = normalizeText(unit.dimensions);
      const dimensions = rawDimensions ? cleanDimensionText(rawDimensions) : null;
      const rawArea = normalizeText(unit.area);

      return {
        sheet_id: sheetId,
        sheet_title: sheetTitle,
        sheet_type: sheetType,
        room_name: roomName,
        dimensions: dimensions || null,
        area: rawArea || null,
        door_tags: [...textArray(unit.door_tags), ...textArray(unit.door_tags_found)],
        window_tags: [...textArray(unit.window_tags), ...textArray(unit.window_tags_found)],
        notes: normalizeText(unit.notes),
        source
      };
    })
    .filter((room) => isDimensionReviewRoom(room.room_name));
}

function extractionSources(splitResult: SplitResult) {
  return splitResult.sheets.map((sheet, index) => `${sheetFolderName(sheet, index)}.json`);
}

function buildDimensionReport(extracted: Array<Record<string, unknown>>) {
  const findings = extracted.flatMap((sheet) => runDimensionsForSheet(sheet));

  return {
    summary: {
      passCount: findings.filter((finding) => finding.status === "PASS").length,
      verifyCount: findings.filter((finding) => finding.status === "VERIFY").length,
      flagCount: findings.filter((finding) => finding.status === "FLAG").length,
      notes:
        "Dimension review used the current extraction data plus the local bcbc-dimensions skill, without requiring saved output files."
    },
    findings
  };
}

function buildRoomMeasurementReport(extracted: Array<Record<string, unknown>>, sources: string[]) {
  const rooms = extracted.flatMap((sheet, index) => extractRoomMeasurementsForSheet(sheet, sources[index] ?? "Vision extractor"));

  return {
    summary: {
      roomCount: rooms.length,
      dimensionedRoomCount: rooms.filter((room) => Boolean(room.dimensions)).length,
      notes: "Room measurements were built from the current vision extraction data."
    },
    rooms
  };
}

async function runRoomMeasurementsOnly() {
  const { runDir, splitResult } = await loadLatestSplit();
  const extractedDir = join(runDir, "extracted");
  const files = (await readdir(extractedDir)).filter((file) => file.endsWith(".json")).sort();

  if (!files.length) {
    return NextResponse.json(
      { error: "No saved extraction JSON found. Run Extract Saved Sheets first." },
      { status: 422 }
    );
  }

  const extracted = await Promise.all(files.map((file) => readJson<Record<string, unknown>>(join(extractedDir, file))));
  const roomMeasurements = buildRoomMeasurementReport(extracted, files);

  await writeFile(
    join(runDir, "room-measurements.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        ...roomMeasurements
      },
      null,
      2
    )
  );

  return NextResponse.json(
    toClientPayload({
      splitResult,
      artifacts: {
        runDir,
        relativeRunDir: join("output", basename(runDir)),
        latestDir: latestRunDir()
      },
      extracted,
      roomMeasurements
    })
  );
}

function decodeOpeningTag(tag: string) {
  const compact = tag.replace(/[^0-9]/g, "");
  if (!/^\d{4}$/.test(compact)) return null;

  const widthFeet = Number(compact[0]);
  const widthInches = Number(compact[1]);
  const heightFeet = Number(compact[2]);
  const heightInches = Number(compact[3]);

  if (![widthFeet, widthInches, heightFeet, heightInches].every(Number.isFinite)) return null;

  const widthMm = Math.round((widthFeet * 12 + widthInches) * 25.4);
  const heightMm = Math.round((heightFeet * 12 + heightInches) * 25.4);

  return {
    widthMm,
    heightMm,
    label: `${compact} = ${widthFeet}'-${widthInches}" x ${heightFeet}'-${heightInches}" (${widthMm}mm x ${heightMm}mm)`
  };
}

function isBedroomLike(roomName: string) {
  return roomName.toUpperCase().includes("BED");
}

function openingStatus({
  kind,
  roomName,
  decoded
}: {
  kind: OpeningTag["kind"];
  roomName: string;
  decoded: ReturnType<typeof decodeOpeningTag>;
}): Pick<OpeningTag, "egress_status" | "egress_note"> {
  if (!decoded) {
    return {
      egress_status: "VERIFY",
      egress_note: "Tag could not be decoded as a standard 4-digit size. Confirm on the drawing."
    };
  }

  if (kind === "door") {
    const minimum = doorMinimumForRoom(roomName);

    if (decoded.widthMm < 457 || decoded.heightMm < 1829) {
      return {
        egress_status: "VERIFY",
        egress_note:
          "Decoded door size is physically unlikely, so this is probably an OCR misread. Recheck with a zoom crop before code review."
      };
    }

    const isTooSmall = decoded.widthMm < minimum.width || decoded.heightMm < minimum.height;

    return {
      egress_status: isTooSmall ? "FLAG" : "PASS",
      egress_note: isTooSmall
        ? `Decoded door size is below the BCBC minimum for ${minimum.category}.`
        : `Decoded door size meets the BCBC ${minimum.width}mm x ${minimum.height}mm minimum for ${minimum.category}.`
    };
  }

  if (isBedroomLike(roomName)) {
    return {
      egress_status: "VERIFY",
      egress_note:
        "Bedroom window tag was decoded, but egress needs clear opening area, clear opening dimensions, sill height, and operation type."
    };
  }

  return {
    egress_status: "VERIFY",
    egress_note: "Window tag decoded. Confirm whether this window participates in bedroom egress or smoke/fire separation checks."
  };
}

function uniqueTags(tags: string[]) {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter(Boolean)
        .filter((tag) => {
          const compact = tag.replace(/[^0-9]/g, "");
          if (!compact || /^0+$/.test(compact)) return false;
          return true;
        })
    )
  );
}

function extractOpeningsForSheet(sheet: Record<string, unknown>, source: string) {
  const sheetId = normalizeText(sheet.sheet_id) || "UNKNOWN";
  const sheetTitle = normalizeText(sheet.title) || "Untitled sheet";
  const sheetType = inferDimensionSheetType(sheet);

  if (!sheetId.toUpperCase().startsWith("A")) return [];

  const openings: OpeningTag[] = [];
  const units = objectArray(sheet.units);

  units.forEach((unit, index) => {
    const roomName = roomLabel(unit, index);

    uniqueTags([...textArray(unit.door_tags), ...textArray(unit.door_tags_found)]).forEach((tag) => {
      const decoded = decodeOpeningTag(tag);
      const status = openingStatus({ kind: "door", roomName, decoded });

      openings.push({
        sheet_id: sheetId,
        sheet_title: sheetTitle,
        sheet_type: sheetType,
        room_name: roomName,
        tag,
        kind: "door",
        decoded_size: decoded?.label ?? null,
        width_mm: decoded?.widthMm ?? null,
        height_mm: decoded?.heightMm ?? null,
        ...status,
        source
      });
    });

    uniqueTags([...textArray(unit.window_tags), ...textArray(unit.window_tags_found)]).forEach((tag) => {
      const decoded = decodeOpeningTag(tag);
      const status = openingStatus({ kind: "window", roomName, decoded });

      openings.push({
        sheet_id: sheetId,
        sheet_title: sheetTitle,
        sheet_type: sheetType,
        room_name: roomName,
        tag,
        kind: "window",
        decoded_size: decoded?.label ?? null,
        width_mm: decoded?.widthMm ?? null,
        height_mm: decoded?.heightMm ?? null,
        ...status,
        source
      });
    });
  });

  uniqueTags(textArray(sheet.door_tags_found)).forEach((tag) => {
    const decoded = decodeOpeningTag(tag);
    const status = openingStatus({ kind: "door", roomName: "Unassigned", decoded });

    openings.push({
      sheet_id: sheetId,
      sheet_title: sheetTitle,
      sheet_type: sheetType,
      room_name: "Unassigned",
      tag,
      kind: "door",
      decoded_size: decoded?.label ?? null,
      width_mm: decoded?.widthMm ?? null,
      height_mm: decoded?.heightMm ?? null,
      ...status,
      source
    });
  });

  uniqueTags(textArray(sheet.window_tags_found)).forEach((tag) => {
    const decoded = decodeOpeningTag(tag);
    const status = openingStatus({ kind: "window", roomName: "Unassigned", decoded });

    openings.push({
      sheet_id: sheetId,
      sheet_title: sheetTitle,
      sheet_type: sheetType,
      room_name: "Unassigned",
      tag,
      kind: "window",
      decoded_size: decoded?.label ?? null,
      width_mm: decoded?.widthMm ?? null,
      height_mm: decoded?.heightMm ?? null,
      ...status,
      source
    });
  });

  return openings;
}

function buildOpeningReport(extracted: Array<Record<string, unknown>>, sources: string[]) {
  const tags = extracted.flatMap((sheet, index) => extractOpeningsForSheet(sheet, sources[index] ?? "Vision extractor"));

  return {
    summary: {
      tagCount: tags.length,
      doorCount: tags.filter((tag) => tag.kind === "door").length,
      windowCount: tags.filter((tag) => tag.kind === "window").length,
      passCount: tags.filter((tag) => tag.egress_status === "PASS").length,
      verifyCount: tags.filter((tag) => tag.egress_status === "VERIFY").length,
      flagCount: tags.filter((tag) => tag.egress_status === "FLAG").length,
      notes:
        "Door/window tags were extracted from the current vision extraction data. Window egress remains VERIFY unless clear opening and sill data are extracted."
    },
    tags
  };
}

async function runOpeningsOnly() {
  const { runDir, splitResult } = await loadLatestSplit();
  const extractedDir = join(runDir, "extracted");
  const files = (await readdir(extractedDir)).filter((file) => file.endsWith(".json")).sort();

  if (!files.length) {
    return NextResponse.json(
      { error: "No saved extraction JSON found. Run Extract Saved Sheets first." },
      { status: 422 }
    );
  }

  const extracted = await Promise.all(files.map((file) => readJson<Record<string, unknown>>(join(extractedDir, file))));
  const openings = buildOpeningReport(extracted, files);

  await writeFile(
    join(runDir, "opening-egress-tags.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        ...openings
      },
      null,
      2
    )
  );

  return NextResponse.json(
    toClientPayload({
      splitResult,
      artifacts: {
        runDir,
        relativeRunDir: join("output", basename(runDir)),
        latestDir: latestRunDir()
      },
      extracted,
      openings
    })
  );
}

function makeIssue(
  issues: PrecheckIssue[],
  severity: PrecheckIssue["severity"],
  sheetId: string,
  category: string,
  issue: string,
  recommendedAction: string,
  source: string,
  officialSourceUrl: string,
  evidence: string
) {
  issues.push({
    severity,
    sheet_id: sheetId,
    category,
    issue,
    source,
    evidence,
    recommended_action: recommendedAction,
    official_source_url: officialSourceUrl
  });
}

function buildPrecheckReport(extracted: Array<Record<string, unknown>>) {
  const issues: PrecheckIssue[] = [];

  for (const sheet of extracted) {
    const sheetId = stringValue(sheet.sheet_id) || "UNKNOWN";
    const confidence = numberValue(sheet.extraction_confidence);
    const completeness = sheet.completeness_check as Record<string, unknown> | undefined;
    const completenessPct = numberValue(completeness?.completeness_pct);
    const expectedDimensions = numberValue(completeness?.expected_dimension_strings);
    const extractedDimensions = numberValue(completeness?.extracted_dimension_strings);
    const expectedDoors = numberValue(completeness?.expected_door_tags);
    const extractedDoors = numberValue(completeness?.extracted_door_tags);
    const expectedWindows = numberValue(completeness?.expected_window_tags);
    const extractedWindows = numberValue(completeness?.extracted_window_tags);
    const lowConfidenceItems = Array.isArray(sheet.low_confidence_items) ? sheet.low_confidence_items : [];
    const unitsCount = arrayLength(sheet.units);
    const floorLevelsCount = arrayLength(sheet.floor_levels);
    const annotationsCount = arrayLength(sheet.annotations);
    const structuralNotes = textArray(sheet.structural_notes);
    const projectMetadata = sheet.project_metadata as Record<string, unknown> | undefined;
    const sheetType = inferPrecheckSheetType(sheet);
    const siteData = sheet.site_data;

    if (confidence > 0 && confidence < 70) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "confidence",
        `Extraction confidence is ${confidence}%.`,
        "Review this sheet manually or rerun extraction at 300 DPI.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `extraction_confidence=${confidence}`
      );
    }

    if (completenessPct > 0 && completenessPct < 75) {
      makeIssue(
        issues,
        completenessPct < 50 ? "blocker" : "warning",
        sheetId,
        "completeness",
        `Extraction completeness is ${completenessPct}%.`,
        "Check missing dimensions/tags before relying on downstream code checks.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `completeness_check.completeness_pct=${completenessPct}`
      );
    }

    if (expectedDimensions > 0 && extractedDimensions === 0 && sheetType !== "elevation") {
      makeIssue(
        issues,
        "blocker",
        sheetId,
        "dimensions",
        "Dimension strings were expected but none were extracted.",
        "Confirm dimensions from the split PDF before submission.",
        sheetType === "site" ? "Surrey Zoning Bylaw 12000" : "BCBC 2024 drawing completeness",
        sheetType === "site" ? OFFICIAL_SOURCES.surreyZoningBylaw12000 : OFFICIAL_SOURCES.bcbc2024,
        `expected_dimension_strings=${expectedDimensions}, extracted_dimension_strings=${extractedDimensions}`
      );
    }

    if (expectedDoors > 0 && extractedDoors === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "doors",
        "Door tags were expected but none were extracted.",
        "Review door tags and egress-related openings.",
        "BCBC 2024 egress/opening coordination",
        OFFICIAL_SOURCES.bcbc2024,
        `expected_door_tags=${expectedDoors}, extracted_door_tags=${extractedDoors}`
      );
    }

    if (expectedWindows > 0 && extractedWindows === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "windows",
        "Window tags were expected but none were extracted.",
        "Review window tags, bedroom egress windows, and fenestration references.",
        "BCBC 2024 egress/fenestration coordination",
        OFFICIAL_SOURCES.bcbc2024,
        `expected_window_tags=${expectedWindows}, extracted_window_tags=${extractedWindows}`
      );
    }

    if (sheetType === "floor-plan" && unitsCount === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "rooms",
        "Floor-plan-like sheet has no extracted rooms/units.",
        "Confirm room labels, room dimensions, stairs, smoke/CO alarms, and suite separation notes before city review.",
        "BCBC 2024 Part 9 drawing completeness",
        OFFICIAL_SOURCES.bcbc2024,
        `inferred_sheet_type=${sheetType}, units.length=${unitsCount}`
      );
    }

    if (sheetType === "site" && !siteData) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "site",
        "Site plan has no extracted site_data.",
        "Confirm lot dimensions, setbacks, parking, FAR/lot coverage, grades, trees, services, and zoning table.",
        "Surrey Zoning Bylaw 12000",
        OFFICIAL_SOURCES.surreyZoningBylaw12000,
        "site_data=null"
      );
    }

    if (sheetType === "elevation" && floorLevelsCount === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "elevations",
        "Elevation sheet has no extracted floor levels or height markers.",
        "Confirm building height, average grade, roof ridge, roof plate, floor levels, materials, and openings.",
        "Surrey Zoning Bylaw 12000 height/setback review and BCBC 2024 elevation completeness",
        OFFICIAL_SOURCES.surreyZoningBylaw12000,
        `inferred_sheet_type=${sheetType}, floor_levels.length=${floorLevelsCount}`
      );
    }

    if (sheetType === "section" && structuralNotes.length === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "sections",
        "Section-like sheet has no extracted structural or assembly notes.",
        "Confirm ceiling heights, floor-to-floor heights, foundation/slab notes, insulation, vapour barrier, rainscreen, and fire separations.",
        "BCBC 2024 Part 9 section/detail completeness",
        OFFICIAL_SOURCES.bcbc2024,
        `inferred_sheet_type=${sheetType}, structural_notes.length=${structuralNotes.length}`
      );
    }

    if (sheetType === "site") {
      const metadataText = JSON.stringify(sheet).toUpperCase();
      const hasAddress = metadataText.includes("SURREY") || /\d{4,}/.test(metadataText);
      const hasZone = metadataText.includes("ZONE") || metadataText.includes("RF") || metadataText.includes("R3");

      if (!hasAddress) {
        makeIssue(
          issues,
          "needs_clarification",
          sheetId,
          "project-context",
          "Civic address was not confidently extracted from the site plan data.",
          "Confirm civic address before applying Surrey zoning and servicing checks.",
          "Surrey permit intake context",
          OFFICIAL_SOURCES.surreyBylaws,
          "address not found in extracted site data"
        );
      }

      if (!hasZone) {
        makeIssue(
          issues,
          "needs_clarification",
          sheetId,
          "zoning",
          "Zoning category was not confidently extracted.",
          "Confirm the property zone in Surrey COSMOS or the zoning data before checking setbacks, height, use, parking, and density.",
          "Surrey Zoning Bylaw 12000",
          OFFICIAL_SOURCES.surreyZoning,
          "zone not found in extracted site data"
        );
      }
    }

    const codeCompliance = stringValue(projectMetadata?.code_compliance);
    if (codeCompliance && !codeCompliance.includes("2024") && codeCompliance.includes("2018")) {
      makeIssue(
        issues,
        "needs_clarification",
        sheetId,
        "code-edition",
        "Extracted title block references the 2018 BC Building Code.",
        "Confirm permit application date and whether BCBC 2024 applies before final code review.",
        "BC Building Code 2024 effective-date guidance",
        OFFICIAL_SOURCES.bcbc2024,
        `project_metadata.code_compliance=${codeCompliance}`
      );
    }

    if (lowConfidenceItems.length > 0) {
      makeIssue(
        issues,
        "info",
        sheetId,
        "low-confidence",
        `${lowConfidenceItems.length} low-confidence item(s) were reported.`,
        "Review low_confidence_items in the extracted JSON.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `low_confidence_items.length=${lowConfidenceItems.length}`
      );
    }

    if (annotationsCount === 0 && sheetType !== "site") {
      makeIssue(
        issues,
        "info",
        sheetId,
        "annotations",
        "No general annotations were extracted.",
        "Spot-check notes/callouts on the split sheet PDF.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `inferred_sheet_type=${sheetType}, annotations.length=${annotationsCount}`
      );
    }
  }

  return {
    summary: {
      blockerCount: issues.filter((issue) => issue.severity === "blocker").length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      infoCount: issues.filter((issue) => issue.severity === "info").length,
      clarificationCount: issues.filter((issue) => issue.severity === "needs_clarification").length,
      notes:
        "Precheck used the current extraction data plus local Surrey/BCBC skill rules, without requiring saved output files."
    },
    issues
  };
}

async function runPrecheckOnly() {
  const { runDir, splitResult } = await loadLatestSplit();
  const skillRules = await readFile(join(SURREY_SKILL_ROOT, "references", "precheck-rules.md"), "utf8");
  const skillSources = await readFile(join(SURREY_SKILL_ROOT, "references", "official-sources.md"), "utf8");
  const extractedDir = join(runDir, "extracted");
  const files = (await readdir(extractedDir)).filter((file) => file.endsWith(".json")).sort();

  if (!files.length) {
    return NextResponse.json(
      { error: "No saved extraction JSON found. Run Vision Extract Saved Sheets first." },
      { status: 422 }
    );
  }

  const extracted = await Promise.all(files.map((file) => readJson<Record<string, unknown>>(join(extractedDir, file))));
  const issues: PrecheckIssue[] = [];

  for (const sheet of extracted) {
    const sheetId = stringValue(sheet.sheet_id) || "UNKNOWN";
    const confidence = numberValue(sheet.extraction_confidence);
    const completeness = sheet.completeness_check as Record<string, unknown> | undefined;
    const completenessPct = numberValue(completeness?.completeness_pct);
    const expectedDimensions = numberValue(completeness?.expected_dimension_strings);
    const extractedDimensions = numberValue(completeness?.extracted_dimension_strings);
    const expectedDoors = numberValue(completeness?.expected_door_tags);
    const extractedDoors = numberValue(completeness?.extracted_door_tags);
    const expectedWindows = numberValue(completeness?.expected_window_tags);
    const extractedWindows = numberValue(completeness?.extracted_window_tags);
    const lowConfidenceItems = Array.isArray(sheet.low_confidence_items) ? sheet.low_confidence_items : [];
    const unitsCount = arrayLength(sheet.units);
    const floorLevelsCount = arrayLength(sheet.floor_levels);
    const annotationsCount = arrayLength(sheet.annotations);
    const structuralNotes = textArray(sheet.structural_notes);
    const annotations = textArray(sheet.annotations);
    const projectMetadata = sheet.project_metadata as Record<string, unknown> | undefined;
    const sheetType = inferPrecheckSheetType(sheet);
    const siteData = sheet.site_data;

    if (confidence > 0 && confidence < 70) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "confidence",
        `Extraction confidence is ${confidence}%.`,
        "Review this sheet manually or rerun extraction at 300 DPI.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `extraction_confidence=${confidence}`
      );
    }

    if (completenessPct > 0 && completenessPct < 75) {
      makeIssue(
        issues,
        completenessPct < 50 ? "blocker" : "warning",
        sheetId,
        "completeness",
        `Extraction completeness is ${completenessPct}%.`,
        "Check missing dimensions/tags before relying on downstream code checks.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `completeness_check.completeness_pct=${completenessPct}`
      );
    }

    if (expectedDimensions > 0 && extractedDimensions === 0 && sheetType !== "elevation") {
      makeIssue(
        issues,
        "blocker",
        sheetId,
        "dimensions",
        "Dimension strings were expected but none were extracted.",
        "Confirm dimensions from the split PDF before submission.",
        sheetType === "site" ? "Surrey Zoning Bylaw 12000" : "BCBC 2024 drawing completeness",
        sheetType === "site" ? OFFICIAL_SOURCES.surreyZoningBylaw12000 : OFFICIAL_SOURCES.bcbc2024,
        `expected_dimension_strings=${expectedDimensions}, extracted_dimension_strings=${extractedDimensions}`
      );
    }

    if (expectedDoors > 0 && extractedDoors === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "doors",
        "Door tags were expected but none were extracted.",
        "Review door tags and egress-related openings.",
        "BCBC 2024 egress/opening coordination",
        OFFICIAL_SOURCES.bcbc2024,
        `expected_door_tags=${expectedDoors}, extracted_door_tags=${extractedDoors}`
      );
    }

    if (expectedWindows > 0 && extractedWindows === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "windows",
        "Window tags were expected but none were extracted.",
        "Review window tags, bedroom egress windows, and fenestration references.",
        "BCBC 2024 egress/fenestration coordination",
        OFFICIAL_SOURCES.bcbc2024,
        `expected_window_tags=${expectedWindows}, extracted_window_tags=${extractedWindows}`
      );
    }

    if (sheetType === "floor-plan" && unitsCount === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "rooms",
        "Floor-plan-like sheet has no extracted rooms/units.",
        "Confirm room labels, room dimensions, stairs, smoke/CO alarms, and suite separation notes before city review.",
        "BCBC 2024 Part 9 drawing completeness",
        OFFICIAL_SOURCES.bcbc2024,
        `inferred_sheet_type=${sheetType}, units.length=${unitsCount}`
      );
    }

    if (sheetType === "site" && !siteData) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "site",
        "Site plan has no extracted site_data.",
        "Confirm lot dimensions, setbacks, parking, FAR/lot coverage, grades, trees, services, and zoning table.",
        "Surrey Zoning Bylaw 12000",
        OFFICIAL_SOURCES.surreyZoningBylaw12000,
        "site_data=null"
      );
    }

    if (sheetType === "elevation" && floorLevelsCount === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "elevations",
        "Elevation sheet has no extracted floor levels or height markers.",
        "Confirm building height, average grade, roof ridge, roof plate, floor levels, materials, and openings.",
        "Surrey Zoning Bylaw 12000 height/setback review and BCBC 2024 elevation completeness",
        OFFICIAL_SOURCES.surreyZoningBylaw12000,
        `inferred_sheet_type=${sheetType}, floor_levels.length=${floorLevelsCount}`
      );
    }

    if (sheetType === "section" && structuralNotes.length === 0) {
      makeIssue(
        issues,
        "warning",
        sheetId,
        "sections",
        "Section-like sheet has no extracted structural or assembly notes.",
        "Confirm ceiling heights, floor-to-floor heights, foundation/slab notes, insulation, vapour barrier, rainscreen, and fire separations.",
        "BCBC 2024 Part 9 section/detail completeness",
        OFFICIAL_SOURCES.bcbc2024,
        `inferred_sheet_type=${sheetType}, structural_notes.length=${structuralNotes.length}`
      );
    }

    if (sheetType === "site") {
      const metadataText = JSON.stringify(sheet).toUpperCase();
      const hasAddress = metadataText.includes("SURREY") || /\d{4,}/.test(metadataText);
      const hasZone = metadataText.includes("ZONE") || metadataText.includes("RF") || metadataText.includes("R3");

      if (!hasAddress) {
        makeIssue(
          issues,
          "needs_clarification",
          sheetId,
          "project-context",
          "Civic address was not confidently extracted from the site plan data.",
          "Confirm civic address before applying Surrey zoning and servicing checks.",
          "Surrey permit intake context",
          OFFICIAL_SOURCES.surreyBylaws,
          "address not found in extracted site data"
        );
      }

      if (!hasZone) {
        makeIssue(
          issues,
          "needs_clarification",
          sheetId,
          "zoning",
          "Zoning category was not confidently extracted.",
          "Confirm the property zone in Surrey COSMOS or the zoning data before checking setbacks, height, use, parking, and density.",
          "Surrey Zoning Bylaw 12000",
          OFFICIAL_SOURCES.surreyZoning,
          "zone not found in extracted site data"
        );
      }
    }

    const codeCompliance = stringValue(projectMetadata?.code_compliance);
    if (codeCompliance && !codeCompliance.includes("2024") && codeCompliance.includes("2018")) {
      makeIssue(
        issues,
        "needs_clarification",
        sheetId,
        "code-edition",
        "Extracted title block references the 2018 BC Building Code.",
        "Confirm permit application date and whether BCBC 2024 applies before final code review.",
        "BC Building Code 2024 effective-date guidance",
        OFFICIAL_SOURCES.bcbc2024,
        `project_metadata.code_compliance=${codeCompliance}`
      );
    }

    if (lowConfidenceItems.length > 0) {
      makeIssue(
        issues,
        "info",
        sheetId,
        "low-confidence",
        `${lowConfidenceItems.length} low-confidence item(s) were reported.`,
        "Review low_confidence_items in the extracted JSON.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `low_confidence_items.length=${lowConfidenceItems.length}`
      );
    }

    if (annotationsCount === 0 && sheetType !== "site") {
      makeIssue(
        issues,
        "info",
        sheetId,
        "annotations",
        "No general annotations were extracted.",
        "Spot-check notes/callouts on the split sheet PDF.",
        "Surrey plan intake QA",
        OFFICIAL_SOURCES.surreyBylaws,
        `inferred_sheet_type=${sheetType}, annotations.length=${annotations.length}`
      );
    }
  }

  const precheck = {
    summary: {
      blockerCount: issues.filter((issue) => issue.severity === "blocker").length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      infoCount: issues.filter((issue) => issue.severity === "info").length,
      clarificationCount: issues.filter((issue) => issue.severity === "needs_clarification").length,
      notes: "Precheck used saved extraction JSON plus the local Surrey plan-precheck skill rules, so it did not spend PDF/image tokens."
    },
    issues
  };

  await writeFile(
    join(runDir, "precheck-report.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        skill: {
          name: "surrey-plan-precheck",
          rules_reference: join(SURREY_SKILL_ROOT, "references", "precheck-rules.md"),
          official_sources_reference: join(SURREY_SKILL_ROOT, "references", "official-sources.md"),
          loaded_rule_bytes: skillRules.length,
          loaded_source_bytes: skillSources.length
        },
        ...precheck
      },
      null,
      2
    )
  );

  return NextResponse.json(
    toClientPayload({
      splitResult,
      artifacts: {
        runDir,
        relativeRunDir: join("output", basename(runDir)),
        latestDir: latestRunDir()
      },
      extracted,
      precheck
    })
  );
}

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const formData = await request.formData();
  const action = String(formData.get("action") ?? "full");
  const file = formData.get("file");
  const pageValue = String(formData.get("page") ?? "page-03");
  const dpiValue = Number(formData.get("dpi") ?? DEFAULT_DPI);
  const dpi = Number.isFinite(dpiValue) ? Math.min(Math.max(dpiValue, 100), MAX_DPI) : DEFAULT_DPI;

  try {
    if (action === "listSavedPages") {
      return await listSavedPages();
    }

    if (action === "loadPagePlanCheck" || action === "loadPage03PlanCheck") {
      return await loadSavedPagePlanCheck(pageValue);
    }

    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Missing ANTHROPIC_API_KEY on the server. Add it to your production environment variables, then redeploy."
        },
        { status: 500 }
      );
    }

    if (action === "pagePlanCheck" || action === "page03PlanCheck") {
      return await runPagePlanCheck(apiKey, pageValue);
    }

    if (file instanceof File) {
      if (file.type !== "application/pdf") {
        return NextResponse.json({ error: "Only PDF files are supported." }, { status: 400 });
      }

      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: "PDF must be 32MB or smaller for this first pass." }, { status: 413 });
      }

      if (action === "split") {
        return await runSplitOnly({ file, dpi, apiKey });
      }

      return await runFullReportOnTheFly({ file, dpi, apiKey });
    }

    if (action === "extract") {
      return await runExtractionOnly(apiKey);
    }

    if (action === "precheck") {
      return await runPrecheckOnly();
    }

    if (action === "dimensions") {
      return await runDimensionsOnly();
    }

    if (action === "rooms") {
      return await runRoomMeasurementsOnly();
    }

    if (action === "openings") {
      return await runOpeningsOnly();
    }

    return NextResponse.json({ error: "Upload a PDF file." }, { status: 400 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    console.error("sheet-splitter failed", {
      action,
      hasFile: file instanceof File,
      fileName: file instanceof File ? file.name : null,
      fileSize: file instanceof File ? file.size : null,
      hasAnthropicKey: Boolean(apiKey),
      hasPdfLambdaUrl: Boolean(pdfLambdaUrl()),
      nodeEnv: process.env.NODE_ENV,
      awsBranch: process.env.AWS_BRANCH,
      message: errorMessage
    });
    const isSavedOutputError =
      errorMessage.includes("output/latest") ||
      errorMessage.includes("sheets.json") ||
      errorMessage.includes("extracted");
    const friendly =
      errorMessage.includes("ENOENT") && isSavedOutputError
        ? "No saved split output found. Run Split PDF first."
        : error instanceof Error
          ? error.message
          : "Sheet splitter failed.";

    return NextResponse.json(
      {
        error: friendly,
        diagnostics: {
          action,
          hasAnthropicKey: Boolean(apiKey),
          hasPdfLambdaUrl: Boolean(pdfLambdaUrl()),
          runtime: isHostedRuntime() ? "hosted" : "local"
        }
      },
      { status: 500 }
    );
  }
}
