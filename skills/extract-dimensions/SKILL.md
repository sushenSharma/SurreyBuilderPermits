---
name: extract-dimensions
description: >
  Use when extracting dimension strings, room sizes, door tags, window tags,
  stair specs, and all measurements from split architectural drawing page images.
  Input is a PNG page image from the pages/ folder. Output is structured JSON.
  Run AFTER sheet-splitter. Run BEFORE any BCBC code checking agents.
  Do NOT check against code — only extract what is drawn.
---

# Dimension Extraction Skill

## What you are reading
E5Home Design Inc. architectural drawings for a residential fourplex/houseplex.
Drawings follow BC architectural drafting conventions:
- Imperial units throughout (feet and inches)
- Dimension format: feet'-inches" (e.g. 9'-2", 11'-10½", 0'-9½")
- Fractions written as ½, ¼, ¾ (not decimals)
- Room sizes written inside rooms as W x D (e.g. "9'2 x 11'10")
- Door tags are 4-digit codes (e.g. 2668, 2868, 3068, 5068)
- Window tags are 4-digit codes (e.g. 5020, 2040, 3040)
- Scale noted in title block bottom right

---

## Where dimensions live on these drawings

### 1. Outer dimension chains (highest priority)
Located along all 4 edges of the floor plan, outside the building outline.
Always two rows minimum:
- **Outer row**: overall building dimension (e.g. 54'-0")
- **Inner row(s)**: chain of smaller dims that should add up to the outer total

Read left to right along top and bottom.
Read top to bottom along left and right sides.
Capture every number in sequence — do not skip any.

### 2. Room label + size inside each room
Written directly inside the room boundary, two lines:
- Line 1: room name in capitals (e.g. BEDROOM 2, MASTER BEDROOM, 3 PC BATH)
- Line 2: dimensions as W x D (e.g. 9'2 x 11'10 or 10'3" x 9'4")

Some rooms show only a label with no size — capture the label anyway with size: null.

### 3. Internal partition dimensions
Short dimension strings between walls inside the plan.
Written with tick marks at each end.
Often appear between rooms to show wall thickness or offset distances.
These are separate from room sizes — capture both.

### 4. Door tags
Small 4-digit number next to each door swing arc.
Always decode using this table:
- First 2 digits = width in inches (26 = 2'-6", 28 = 2'-8", 30 = 3'-0" etc.)
- Last 2 digits = height in inches (68 = 6'-8", 80 = 8'-0" etc.)

Common tags on E5Home drawings:
| Tag | Width | Height | Typical location |
|-----|-------|--------|-----------------|
| 2068 | 2'-0" (610mm) | 6'-8" (2032mm) | Closets |
| 2668 | 2'-6" (762mm) | 6'-8" (2032mm) | Interior rooms |
| 2868 | 2'-8" (813mm) | 6'-8" (2032mm) | Bathrooms, bedrooms |
| 3068 | 3'-0" (914mm) | 6'-8" (2032mm) | Main rooms |
| 4068 | 4'-0" (1219mm) | 6'-8" (2032mm) | Utility/storage |
| 5068 | 5'-0" (1524mm) | 6'-8" (2032mm) | Wide openings |
| 5020 | Window 5'-0" | 2'-0" | Basement windows |
| 2040 | Window 2'-0" | 4'-0" | Side windows |
| 3040 | Window 3'-0" | 4'-0" | Standard windows |

### Door tag sanity check — run on EVERY tag before outputting
After decoding any door tag, verify the result is physically possible.
A real door on these drawings will ALWAYS have:
- Width between 1'-6" (18") and 6'-0" (72")
- Height between 6'-0" (72") and 9'-0" (108")

**If decoded height < 6'-0" OR decoded width < 1'-6":**
The tag was misread. Do NOT output it as a valid door tag.
Instead output it as a misread entry and route to clarification only:

```json
{
  "tag_raw": "2004",
  "status": "MISREAD",
  "decoded_width": "2'-0\"",
  "decoded_height": "0'-4\"",
  "reason": "Decoded height 4\" is physically impossible for a door",
  "likely_actual_tags": ["2068", "2668", "2868"],
  "common_misread_cause": "digit '0' misread for '6' in dense drawing area",
  "location": "A103 unit_1 bedroom_2",
  "action": "clarification_agent_only",
  "do_not_pass_to_code_checker": true
}
```

**Common misread patterns on E5Home drawings:**

| Misread tag | Likely actual | Why |
|---|---|---|
| `2004` | `2068` or `2868` | `6` misread as `0` in last two digits |
| `2006` | `2668` or `2868` | `6` misread as `0`, `8` misread as `6` |
| `2044` | `2644` or `2844` | `6` misread as `0` |
| `3004` | `3068` | `6` misread as `0`, `8` misread as `4` |
| Any tag where last 2 digits < 60 | Likely misread | No standard door is under 5'-0" high |

**The `6` vs `0` problem:**
In dense, small-scale drawings the digit `6` and `0` look nearly identical at low OCR resolution.
The last two digits of a door tag are ALWAYS 68, 80, or occasionally 76, 84, 90.
If you read last two digits as anything other than these values, treat it as a misread.

Valid last-two-digit values for door height:
- `68` = 6'-8" ✓ (most common by far)
- `80` = 8'-0" ✓ (tall doors)
- `76` = 6'-4" ✓ (rare)
- `84` = 7'-0" ✓ (rare)
- `90` = 7'-6" ✓ (rare)
- Anything else → MISREAD, flag it

### 5. Window tags
Same 4-digit format as doors but appear on wall lines not door arcs.
Prefix with "W-" in your output to distinguish from doors.

### 6. Stair specifications
Look for stair symbols (hatched rectangle with arrow).
Near stairs you will find:
- Number of risers (e.g. "16 R")
- Riser height (e.g. "7½"")
- Tread depth (e.g. "T9.5"" or "T 9.05"")
- Handrail note (e.g. "36" HAND RAIL")
- Direction arrow with "UP" or "DN"

### 7. Notes and annotations
- Slab specs (e.g. "3½" CONC. SLAB, 6 MIL POLY V.B., 6" MIN. COMPACTED SAND OR GRAVEL FILL")
- Radon rough-in callouts
- Smoke alarm symbols (S in circle)
- CO alarm symbols (S+C or C in circle)
- HWT (hot water tank) labels
- Revision clouds with change notes

### 8. Key plan inset (top right corner)
Small scale overview showing all units with area in SF.
Extract unit areas if visible (e.g. "653 SF", "89 SF").

### 9. Title block (bottom right corner)
Always present. Extract:
- Sheet number (e.g. A101, A103)
- Sheet title (e.g. MAIN FLOOR, BASEMENT)
- Scale (e.g. 1/4"=1'-0", 1:50)
- Project number
- Date
- Drawn by / Checked by
- Designer name and address

---

---

## Page type 1 — Site Plan (page-001, SITE PLAN)

### What this page contains
- Large format site plan in colour (red = fourplex footprint, blue = coach house, green = trees/landscaping)
- Survey elevations scattered throughout (format: 85.29, 86.50, 87.02 etc — these are geodetic elevations in metres)
- Manhole/catch basin data in corners (MH-ST, RIM=, N.INV=, W.INV=, E.INV=, S.INV=)
- Property boundary dimensions along all 4 edges
- Two summary tables bottom left: one for 4PLEX, one for COACH HOUSE
- North arrow bottom right
- Lot area, FAR calculations, setbacks, coverage all in text block top left

### What to extract from site plan

**Text block top left — extract every line verbatim:**
- Zoning designation (e.g. R3)
- Lot area in both m² and SQ FT
- Permitted FAR formula and result
- All floor areas per unit (Main, Top, Basement, Garage)
- Proposed FAR calculation
- Permitted/proposed lot coverage %
- Permitted/proposed building height in metres
- Permitted width and depth in metres and feet

**Property boundary dimensions:**
- Along lane (top): total width + chain
- Along 97A Avenue (bottom): total width + chain  
- Left side depth + chain
- Right side depth + chain
- Lot area stated on plan

**Building setbacks (measure or read from plan):**
- Front setback from 97A Avenue
- Rear setback from lane
- Left side setback
- Right side setback
- Note: setbacks shown as dimension strings on the plan

**Survey elevations — extract all visible and classify each one:**
These appear as numbers like 85.29, 86.50, 87.02 scattered across the plan.
They are geodetic elevations in metres above sea level — NOT dimensions between two points.

Classify each elevation by its label and location:

| Label on drawing | Type | Meaning |
|---|---|---|
| No label, on property boundary | `grade_existing` | Existing ground level at that point |
| "ditch top", "ditch bottom" | `drainage` | Ditch/swale elevation |
| "bank bottom", "bank top" | `drainage` | Bank elevation |
| RIM= on manhole symbol | `manhole_rim` | Top of manhole cover |
| N.INV=, S.INV=, E.INV=, W.INV= | `pipe_invert` | Bottom of pipe in that direction |
| P.EL. or P.E.L. | `proposed_elevation` | Proposed finished grade |
| E.EL. or E.E.L. | `existing_elevation` | Existing grade |
| "conc." nearby | `concrete_surface` | Elevation of concrete surface |
| Near building corners | `grade_at_building` | Grade at building foundation |
| "edge of asphalt" | `road_surface` | Road/driveway elevation |

Format each as:
```json
{
  "value_m": 85.29,
  "type": "grade_existing",
  "label": "ditch top",
  "location": "northeast corner near lane",
  "low_confidence": false
}
```

Do NOT confuse survey elevations with dimensions.
Survey elevations are standalone numbers (85.29) not dimension strings (54'-0").

**Manhole/utility data:**
Format: { "id": "MH-ST", "rim": 81.92, "n_inv": 80.19, "w_inv": 80.20, "s_inv": 80.52 }

**Summary tables (bottom left) — extract as structured data:**
Both the 4PLEX table and COACH HOUSE table.
Each row has: floor level, area in SQ FT.

**Impervious/porous area calculations (right side):**
- Proposed impervious area (structure + driveway/walkway)
- Proposed porous area
- Minimum porous area required %
- Proposed porous area %

**Plan reference numbers:**
Numbered zones on plan (11, 12, 1, 14) with PLAN 18729 labels — extract all.

**Scale:** 1:18 (noted in title block bottom right)

---

## Page type 2 — Elevations (page-005 A104, page-006 A105)

### What this page contains (A104 example)
- Front elevation (top left, large, line drawing)
- Back elevation (bottom, large, line drawing)  
- 3D rendered perspective views (top right and bottom left) — do NOT extract dimensions from renders
- Floor level markers on left side of each elevation drawing
- Window tags on window openings
- Dimension strings along top and bottom of elevation
- Roof pitch notation (e.g. 9'/12", 3'/12")
- Cladding callouts (HARDIE PANEL/VINYL SIDING, HORZ HARDIE/VINYL SIDING)
- Guard rail callouts (42" GUARD RAILING AS PER BCBC 2024)
- Exposed wall face area calculation (bottom right of elevation)

### What to extract from elevations

**Floor level markers (left side of each elevation) — highest priority:**
These establish ceiling heights and floor-to-floor heights.
Format: { "level": "MAIN FLOOR", "elevation_m": 87.96 }
Levels present: BASEMENT, AVERAGE GRADE, MAIN FLOOR, TOP FLOOR, ROOF PLATE, MID ROOF, ROOF RIDGE LINE

**Calculate from level markers:**
- Basement to main floor height = Main Floor elev - Basement elev
- Main floor to top floor height = Top Floor elev - Main Floor elev  
- Top floor to roof plate = Roof Plate - Top Floor
- Total building height = Roof Ridge - Average Grade

**Cross-reference flag — link elevation data to floor plans:**
The floor level elevations extracted here are the ONLY source of ceiling height data in the entire drawing set.
Floor plans (A101, A102, A103) do not show ceiling heights.
After extracting level markers, add a cross_reference block to your output:

```json
"cross_reference": {
  "provides_ceiling_heights_for": ["A101", "A102", "A103", "A108"],
  "floor_to_floor_heights": {
    "basement_to_main": "3.05m (10'-0\")",
    "main_to_top": "3.05m (10'-0\")",
    "top_to_roof_plate": "2.43m (8'-0\")"
  },
  "note": "These heights must be used by bcbc-dimensions agent when checking ceiling heights on floor plan sheets. Cannot be verified from floor plans alone."
}
```

This cross_reference block tells the synthesis agent that ceiling height checks on A101/A102/A103 cannot be resolved without this elevation sheet data.

**Roof pitch notation:**
Read the slope triangles on roof lines. Format: rise/run (e.g. "9'/12\"" means 9 rise per 12 run)
Multiple pitches may exist on one drawing.

**Window tags on elevation:**
Same 4-digit format (5050, 3050, 5020 etc).
Note which floor level each window is on.
Note if labelled with "25" below — this is sill height in cm above floor.

**Horizontal dimension chain (along top or bottom):**
Overall building width + bay widths.

**Vertical dimension strings (right side):**
Floor-to-floor heights, parapet heights, overhang dimensions.

**Cladding callouts — extract all text:**
e.g. "HARDIE PANEL/VINYL SIDING", "MIN 18" HARDIE FINISH FACIA", "CLADDING 8" ABOVE GRADE TYP."

**Guard rail callouts:**
e.g. "42" GUARD RAILING AS PER BCBC 2024" — note location (which deck/balcony)

**Exposed wall calculations (if shown):**
SPATIAL, EXPOSED WALL FACE AREA, ALLOWABLE AREA — extract as text.

**Important — skip 3D renders:**
The rendered perspective views (shaded/coloured images) are for visualisation only.
Do NOT attempt to extract dimensions from them. Note their presence but skip.

---

## Page type 3 — Building Section (page-007 A106, page-009)

### What this page contains
- Full building cross-section from foundation to roof ridge
- Vertical dimension strings on both left and right sides
- Floor level markers (same as elevations)
- Room labels inside section (MASTER BED ROOM, 3 PC BATH, STAIR WELL, KITCHEN, LIVING, POWDER)
- Wall assembly callouts (extremely detailed — every layer listed)
- Roof assembly callouts
- Foundation callouts
- Radon vent pipe specification
- Long technical notes at bottom of sheet
- Stair section showing rise/run

### What to extract from sections — this is the most data-rich sheet

**Vertical dimensions (both sides) — highest priority:**
These give you ceiling heights that are not on floor plans.
Left side chain: basement depth, slab thickness, floor-to-floor heights, roof height
Right side chain: same, may differ slightly for party wall section

**Floor level elevations:**
Same format as elevations: BASEMENT 84.91, MAIN FLOOR 87.96, etc.
Calculate all floor-to-floor and floor-to-ceiling heights.

**Room labels in section:**
Note which rooms are visible and on which floor level.

**Wall assembly callouts — extract every layer listed:**
Exterior wall from outside to inside, e.g.:
- 1/2" SHEATHING PLYWOOD
- BUILDING PAPER  
- R20 INSULATION
- MIN 6 MIL POLY V.B.
- 1/2" GYPSUM WALL BOARD
Extract as ordered array of layers with thickness where stated.

**Roof assembly callouts:**
All layers from outside to inside.
Extract R-value, insulation type, venting requirements.

**Foundation callouts:**
- Foundation wall type and thickness
- Damp proofing spec
- Footing dimensions
- Granular fill depth
- Vapour barrier spec

**Slab specification:**
- Slab thickness
- Rigid insulation (type and R-value)
- Granular fill
- Vapour barrier

**Radon vent pipe specification:**
Full text of radon requirements — this is a long note, extract verbatim.

**Party wall / fire separation callout:**
Text describing fire separation assembly between units.
e.g. "2X4 WOOD STUDS AS PER STRUCTURAL DRAWING, 2 LAYER OF 5/8" TYPE X GWB..."
Extract full text — critical for fire separation compliance check.

**Technical notes (bottom of sheet):**
Long paragraphs about radon, air barrier, etc.
Extract each note with its heading.

**Stair section:**
Riser count, rise height, tread depth, stringer size.

---

## Page type 4 — Construction Details (page-011, unknown)

### What this page contains
Multiple detail drawings in a grid layout, each showing a specific construction assembly at large scale.
Detail titles visible: STUCCO/STONE AT RAIN SCREEN WALL, DECK AT WALL, BAND BOARD, WINDOW HEAD, EXTERIOR WALL, WINDOW SILL, EXHAUST VENT, SOLID SOFFIT DETAIL, BOX WINDOW, DETAIL INSULATED OUTSIDE DECK OVER LIVING SPACE, stair detail

### What to extract from construction details

**Detail inventory — list every detail on the sheet:**
Format: { "title": "WINDOW HEAD", "location": "center row right", "scale": null }

**Per detail — extract all callout text:**
Every leader line callout in each detail drawing.
These are the material specifications, sizes, and installation notes.
Format: { "detail": "WINDOW HEAD", "callouts": ["HORIZONTAL VINYL SIDING", "1x4 WOOD TRIM", ...] }

**Dimensions within details:**
Small dimension strings showing thickness of layers, gaps, offsets.
These are in imperial (inches and fractions).
e.g. "5/8\"", "1½\"", "3½\"", "2x6 @ 16\"O.C."

**Stair detail (bottom left):**
- "ENSURE MIN 38" OF NON-CLIMBABLE SURFACE BELOW TOP OF RAILING" — extract verbatim
- "ALL OPENINGS IN STAIRS TO BE MIN 4"" — extract verbatim  
- "MIN WIDTH 32" TYP" — extract
- Wood spindle/baluster specification
- Riser size (2X10 OR 2X12 STAIR STRINGERS)

**Window sill note (bottom center) — extract full text verbatim:**
This is a long installation specification paragraph. Extract it all.

**Climate zone callout:**
"CLIMATE ZONE 4 BOX WINDOW" — note which details reference climate zone.

**Important for construction details:**
Do NOT try to extract overall building dimensions from detail sheets.
These details show assemblies at 1:1 or large scale — dimensions are layer thicknesses, not room sizes.
Focus entirely on material specs, layer sequences, and installation notes.

---

## Coach house pages (page-008 A101, page-009 A102, page-010 A103)

These pages reuse the same sheet numbers as the fourplex but are a completely separate building.
The sheet splitter flags these as duplicates — always include `"building": "Coach House"` in your output.

### How to identify coach house pages visually
- Smaller footprint than fourplex (roughly half the width)
- Garage on ground floor with living space above
- Typically 1-2 units not 4
- Sheet title may say "COACH HOUSE" or "GARAGE/COACH HOUSE"
- Label in title block may say "COACH HOUSE" explicitly

### What differs in coach house extraction vs fourplex

**Floor plan layout:**
- Ground floor: garage bays + utility — extract garage door widths, bay count
- Upper floor: living unit(s) — same room extraction as fourplex floor plans
- Exterior stair to upper unit — extract stair specs same as interior stairs

**Garage specifics:**
- Garage door opening width and height (different from door tags — these are large openings)
- Number of parking stalls
- Overhead door tag if shown

**Unit count:**
Coach house typically has 1-2 units not 4.
Do not force the 4-unit structure onto coach house pages.
Use: `"units": { "unit_ch1": {...}, "unit_ch2": {...} }`

**Summary table reference:**
The site plan has a separate COACH HOUSE summary table.
Cross-reference extracted areas against that table.

**Everything else** (door tags, window tags, stair specs, dimension chains, title block) follows the same rules as fourplex floor plans.

Some sheets contain multiple separate plan drawings at different scales.
You will see this when the title block shows scale as "As Indicated".

For these sheets:
1. Identify each separate plan view — they have their own scale notation nearby
2. Label each zone: "main_plan", "key_plan", "detail_a", "roof_plate" etc.
3. Extract dimensions per zone separately
4. Tag every dimension with which zone it came from
5. Never mix dimensions across zones with different scales

Common multi-plan layouts on E5Home drawings:
- Main floor plan (large, left side) + key plan inset (small, top right)
- Top floor plan + roof plate plan on same sheet
- Floor plan + partial detail view alongside

---

## Step 0 — Detect page type before extracting

Before doing anything else, identify which page type you are reading.
Use the sheet ID from the splitter output AND visual content to confirm:

| Sheet ID | Visual clue | Page type | Extraction section to use |
|---|---|---|---|
| SITE-1, SP | "SITE PLAN" large text top left, coloured plan, survey elevations | Site plan | Page type 1 |
| A101, A103, A108 | Room labels inside plan, 4 unit layout, outer dim chains | Floor plan | Main skill (above) |
| A102 | Roof plate + top floor on same sheet | Multi-plan floor | Main skill + As Indicated |
| A104, A105 | Front/back/side elevations, floor level markers, 3D renders | Elevation | Page type 2 |
| A106, A109 | Full building cross section, wall assembly callouts, foundation | Section | Page type 3 |
| A107, A111 | Grid of small detail drawings, layer callouts, no room labels | Construction detail | Page type 4 |

Once you identify the page type, follow ONLY the extraction rules for that type.
Do not apply floor plan extraction rules to an elevation sheet or vice versa.

---

## Extraction pass strategy

### Pass 1 — Full page read
Send full image to Claude vision.
Extract everything visible: all room labels, all dimension strings, all tags.
Note any areas that appear dense or hard to read.

### Pass 2 — Zone crops for dense areas
If any of these conditions exist, crop and re-extract that zone:
- Dimension strings overlapping or very close together
- Any dimension string where a digit is unclear (marked with ? in pass 1)
- Stair core area (always dense)
- Central corridor/party wall area
- Title block (always extract separately for accuracy)

Crop zones to use on a typical E5Home floor plan:
```
top_dims:        full width, top 15% of image
bottom_dims:     full width, bottom 15% of image  
left_side_dims:  left 15%, full height
right_side_dims: right 15%, full height
upper_left:      left 40%, top 55% (unit 1)
upper_right:     right 40%, top 55% (unit 2)
lower_left:      left 40%, bottom 45% (unit 3)
lower_right:     right 40%, bottom 45% (unit 4)
stair_core:      center 25%, full height
title_block:     right 20%, bottom 20%
key_plan:        right 25%, top 35%
```

Crop zones for site plan:
```
text_block:      left 25%, top 60% (zoning/FAR summary text)
table_4plex:     left 15%, bottom 30%
table_coachhouse:left 30%, bottom 30%
property_top:    full width, top 10% (lane dimensions)
property_bottom: full width, bottom 10% (97A Avenue dimensions)
property_left:   left 8%, full height
property_right:  right 8%, full height
impervious_calcs:right 30%, center 30%
plan_center:     center 50%, center 60% (building footprints + survey elevations)
title_block:     right 15%, bottom 15%
```

Crop zones for elevation sheets:
```
front_elevation:     left 60%, top 50% (main line drawing)
back_elevation:      left 60%, bottom 50% (main line drawing)  
level_markers_left:  left 12%, top 50% (floor level annotations)
level_markers_right: left 12%, bottom 50%
roof_pitch_top:      center 40%, top 20%
window_tags_front:   left 50%, top 30-70%
rendered_view:       right 35%, top 50% (SKIP - 3D render only)
calcs_block:         right 35%, bottom 40%
title_block:         right 15%, bottom 15%
```

Crop zones for section sheets:
```
left_dims:       left 12%, full height (vertical dimension chain)
right_dims:      right 12%, full height (vertical dimension chain)
level_markers:   left 18%, full height (floor level callouts)
wall_assembly:   left 20%, top 50% (exterior wall callouts)
roof_assembly:   center 60%, top 30% (roof callouts)
foundation:      full width, bottom 30%
party_wall:      right 40%, top 60%
room_labels:     center 50%, middle 50%
notes_bottom:    full width, bottom 25% (technical notes)
title_block:     right 15%, bottom 10%
```

Crop zones for construction detail sheets:
```
detail_grid:     identify each detail box separately
stair_detail:    bottom left quadrant
window_head:     identify from title label
window_sill:     identify from title label
wall_assembly:   identify from title label
soffit_detail:   top right area
title_block:     right 15%, bottom 15%
```

### Pass 3 — Verification
Count extracted dimension strings and compare to expected counts.
If extracted count is less than 80% of expected, re-run pass 2 on missed zones.

---

## Critical extraction rules

### Never do these things
- Never round a dimension (9'2½" stays as "9'2½\"" not "9.21 feet")
- Never convert imperial to metric in the extracted value
- Never skip a dimension string because it looks like a duplicate
- Never infer a room size from adjacent walls if not explicitly labeled
- Never combine two separate dimension chains into one
- Never omit a door or window tag even if you think it is a standard size

### Always do these things
- Preserve fractions exactly: ½, ¼, ¾, 1/2, 1/4
- Capture every number in a dimension chain in order
- Record null explicitly when a room label has no size written
- Note which pass (pass1/pass2/pass3) each value came from
- Flag any value where you are less than 90% confident with low_confidence: true

---

## Output format

One JSON file per page image. Filename matches the page:
`page-002.png` → `extracted/002-a101-main-floor.json`

```json
{
  "source_page": "page-002.png",
  "sheet_id": "A101",
  "sheet_title": "MAIN FLOOR",
  "building": "Fourplex",
  "scale_main": "1/4\"=1'-0\"",
  "scale_secondary": "1/8\"=1'-0\"",
  "extraction_passes": 2,
  "extraction_confidence": 94,

  "overall_dimensions": {
    "total_width": "54'-0\"",
    "total_depth": "51'-10\"",
    "top_chain_outer": "54'-0\"",
    "top_chain_row1": [
      "10'-3\"", "6'-3\"", "0'-9½\"", "9'-11¼\"",
      "9'-11¼\"", "1'-3½\"", "5'-9\"", "10'-3\""
    ],
    "top_chain_row2": [
      "0'-10\"", "6'-8\"", "8'-3½\"", "10'-11\"",
      "8'-3½\"", "6'-8\"", "0'-10\""
    ],
    "bottom_chain_outer": "54'-0\"",
    "bottom_chain_row1": [
      "4'-11½\"", "9'-11\"", "17'-4\"", "22'-8\"",
      "17'-4\"", "11'-11½\"", "4'-11¼\"", "9'-10\""
    ],
    "left_vertical_chain": [
      { "zone": "stair_entry", "dim": "4'-2\"" },
      { "zone": "upper_unit_bar", "dim": "15'-2\"" },
      { "zone": "upper_combined", "dim": "21'-6\"" },
      { "zone": "party_wall", "dim": "12'-4\"" },
      { "zone": "total_depth", "dim": "51'-10\"" }
    ],
    "right_vertical_chain": [],
    "chain_verification": {
      "top_row1_sum": "54'-0\"",
      "top_row1_matches_outer": true,
      "bottom_row1_sum": "54'-0\"",
      "bottom_row1_matches_outer": true
    }
  },

  "zones": {
    "main_plan": {
      "scale": "1/4\"=1'-0\"",
      "location": "left and center of sheet"
    },
    "key_plan": {
      "scale": "1/8\"=1'-0\"",
      "location": "upper right corner"
    }
  },

  "units": {
    "unit_1": {
      "location": "upper_left",
      "key_plan_area_sf": 653,
      "rooms": [
        {
          "label": "MASTER BEDROOM",
          "raw_size_text": "11'2 x 12'",
          "width": "11'-2\"",
          "depth": "12'-0\"",
          "area_sqft": 134.3,
          "door_tags": ["3068"],
          "window_tags": [],
          "notes": [],
          "zone": "main_plan",
          "pass": "pass1",
          "low_confidence": false
        },
        {
          "label": "BEDROOM 1",
          "raw_size_text": "12 x 9'4",
          "width": "12'-0\"",
          "depth": "9'-4\"",
          "area_sqft": 112.0,
          "door_tags": ["2868"],
          "window_tags": [],
          "closet": {
            "label": "CLOSET",
            "raw_size_text": "5'9 x 2",
            "width": "5'-9\"",
            "depth": "2'-0\"",
            "door_tags": ["2068"]
          },
          "zone": "main_plan",
          "pass": "pass1",
          "low_confidence": false
        },
        {
          "label": "3 PC BATH",
          "raw_size_text": "5' x 8'",
          "width": "5'-0\"",
          "depth": "8'-0\"",
          "area_sqft": 40.0,
          "door_tags": ["2668"],
          "fixtures": ["toilet", "vanity", "shower"],
          "zone": "main_plan",
          "pass": "pass1",
          "low_confidence": false
        }
      ],
      "internal_partition_dims": [
        { "value": "2'-6\"", "between": "bathroom_wall_to_bedroom", "zone": "main_plan" },
        { "value": "4'-0\"", "between": "corridor_offset", "zone": "main_plan" }
      ]
    },
    "unit_2": { "location": "upper_right", "rooms": [] },
    "unit_3": { "location": "lower_left", "rooms": [] },
    "unit_4": { "location": "lower_right", "rooms": [] }
  },

  "stairs": [
    {
      "location": "upper_central_core",
      "serves_units": ["unit_1", "unit_2"],
      "risers": 16,
      "rise": "7½\"",
      "tread": "9.05\"",
      "handrail_height": "36\"",
      "handrail_note": "36\" HAND RAIL",
      "direction": "UP",
      "width_noted": null,
      "radon_at_base": true,
      "zone": "main_plan",
      "pass": "pass2",
      "low_confidence": false
    }
  ],

  "doors": [
    {
      "tag": "2668",
      "width_imperial": "2'-6\"",
      "height_imperial": "6'-8\"",
      "width_mm": 762,
      "height_mm": 2032,
      "location": "unit_1 corridor to bedroom_2",
      "zone": "main_plan"
    }
  ],

  "windows": [
    {
      "tag": "5020",
      "width_imperial": "5'-0\"",
      "height_imperial": "2'-0\"",
      "width_mm": 1524,
      "height_mm": 610,
      "location": "unit_1 exterior wall",
      "zone": "main_plan"
    }
  ],

  "structural_notes": [
    {
      "text": "3½\" CONC. SLAB, 6 MIL POLY V.B., 6\" MIN. COMPACTED SAND OR GRAVEL FILL",
      "locations": ["unit_1 bar zone", "unit_2 bar zone"],
      "zone": "main_plan",
      "pass": "pass1"
    }
  ],

  "safety_devices": [
    { "type": "SMOKE_ALARM", "symbol": "S", "unit": "unit_1", "room": "bar zone", "zone": "main_plan" },
    { "type": "SMOKE_CO_COMBO", "symbol": "S+C", "unit": "unit_1", "room": "suite entry", "zone": "main_plan" }
  ],

  "annotations": [
    {
      "type": "RADON_ROUGHIN",
      "text": "RADON",
      "location": "unit_1 stair base",
      "zone": "main_plan"
    },
    {
      "type": "HWT",
      "text": "HWT",
      "location": "unit_1",
      "zone": "main_plan"
    },
    {
      "type": "REVISION_NOTE",
      "text": "Exterior walls brought in 4\" to reduce FAR",
      "location": "upper right revision cloud",
      "zone": "notes"
    }
  ],

  "title_block": {
    "sheet_number": "A101",
    "sheet_title": "MAIN FLOOR",
    "scale": "1/4\"=1'-0\"",
    "project_number": "12625",
    "date": "2025/05/12",
    "drawn_by": "E5",
    "checked_by": "Checker",
    "designer": "E5HOME DESIGN INC.",
    "designer_address": "13255 62 AVE, Surrey BC",
    "designer_phone": "604-512-9527",
    "designer_email": "e5design@outlook.com",
    "client": "NRGH Services Inc.",
    "client_address": "2827 97A Avenue, Surrey B.C.",
    "code_compliance": "BCBC 2024"
  },

  "fenestration_spec": {
    "present_on_sheet": true,
    "glazing_type": "Vinyl, double glazed, Low-e, gas filled",
    "u_value": 1.40,
    "shgc_minimum": 0.30,
    "code_table": "BCBC Table 9.36.2.7.A",
    "climate_zone": "4 & 5",
    "elements": [
      { "type": "Doors to unconditioned garage", "rating": "UGI 12.0", "u_value": 0.46 },
      { "type": "Attic access hatch", "rating": "RGI 12.0", "r_value": 14.8 },
      { "type": "Front doors", "rating": "UGI 12.0", "u_value": 0.46 },
      { "type": "Glass block", "rating": "UGI 12.9", "u_value": 0.51 },
      { "type": "Overhead garage door conditioned", "rating": "RGI 1.1", "r_value": 6.245 }
    ]
  },

  "key_plan": {
    "scale": "1/8\"=1'-0\"",
    "unit_areas": [
      { "unit": "unit_1", "area_sf": 653 },
      { "unit": "unit_2", "area_sf": 653 },
      { "unit": "unit_3", "area_sf": 653 },
      { "unit": "unit_4", "area_sf": 653 }
    ]
  },

  "completeness": {
    "dimension_strings_found": 45,
    "door_tags_found": 14,
    "window_tags_found": 8,
    "room_labels_found": 12,
    "low_confidence_items": [],
    "unreadable_zones": [],
    "recommended_repass": false,
    "notes": []
  }
}
```

---

## Chain verification rule
After extracting each dimension chain, sum the individual values and compare to the outer total.
This catches misread digits before code checking runs.

### Tolerance — imperial fractions do not always sum perfectly
Due to rounding of fractions (½, ¼, ¾) the chain sum may differ slightly from the stated outer total.
Apply this tolerance rule:

| Difference | Action |
|---|---|
| 0 | `matches_outer: true` |
| > 0 and ≤ 1" | `matches_outer: true`, add note "within rounding tolerance" |
| > 1" and ≤ 3" | `matches_outer: "tolerance_exceeded"`, flag for clarification agent |
| > 3" | `matches_outer: false`, likely a misread digit — re-extract that chain |

Example — passing with rounding:
- Outer: 54'-0"
- Chain sum: 53'-11½" (difference = ½") → matches_outer: true, note "within rounding tolerance"

Example — failing:
- Outer: 54'-0"
- Chain sum: 51'-0" (difference = 3'-0") → matches_outer: false, re-extract

### How to sum imperial fractions
Convert each dimension to total inches first, sum, then convert back.
9'-2" = (9×12)+2 = 110"
11'-10½" = (11×12)+10.5 = 142.5"
Sum in inches, compare to outer in inches, difference in inches.

## Low confidence flagging
Set `low_confidence: true` on any value where:
- A digit was unclear or partially obscured
- Two overlapping text strings made reading ambiguous
- The value seems inconsistent with surrounding dimensions
- You had to guess between two possible readings

Always include what you read in `raw_size_text` even for low confidence items — the downstream clarification agent needs the raw string.

## What to do when a room has no size label
Some rooms on these drawings show only a label, no dimensions.
This is common for:
- Small closets
- Mechanical/utility spaces
- Corridor sections

For these, output:
```json
{
  "label": "CLOSET",
  "raw_size_text": null,
  "width": null,
  "depth": null,
  "area_sqft": null,
  "low_confidence": false,
  "notes": ["No dimensions shown on drawing"]
}
```
Never estimate or infer the size. null is the correct value.

---

## Fallback protocol — when a dimension is still unreadable after pass 2

If a dimension string is still unclear after the zone crop pass, follow this decision tree:

### Step 1 — Try reading partial information
Can you read ANY digits? Even partial?
- Yes → record what you can with `?` for unknown digits: `"9'-?\""`
- No → record as `"unreadable"`

### Step 2 — Check adjacent dimensions for inference
Can the missing value be calculated from surrounding chain dimensions?
Example: outer = 54'-0", all other chain values readable, one missing.
Missing = 54'-0" minus sum of all others.
- If yes → record the calculated value with `"inferred_from_chain": true`
- If no → do not guess

### Step 3 — Record in unreadable_zones
Always add an entry to `completeness.unreadable_zones`:
```json
{
  "zone": "upper_left",
  "pass_failed": "pass2",
  "description": "Dimension string between bathroom and bedroom walls — overlapping text",
  "partial_read": "2'-?\"",
  "inferred_value": null,
  "recommended_action": "Request higher resolution scan of this zone or confirm on site"
}
```

### Step 4 — Set recommended_repass flag
If more than 3 dimension strings are unreadable after pass 2:
Set `completeness.recommended_repass: true`
The orchestrator will re-run extraction at higher DPI (300 instead of 200).

### Never do this
- Never output a guessed value without flagging it
- Never silently drop a dimension string from the output
- Never mark a zone as complete if you know a dimension is missing
- Every unreadable dimension must appear somewhere in the output — either as a partial read, an inferred value, or an unreadable_zones entry
