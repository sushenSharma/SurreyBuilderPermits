# Precheck Rules

Use these as practical screening heuristics against extracted plan JSON. They are not full code text.

## Required Context Checks

Create `needs_clarification` if missing:

- civic address
- zone
- lot area and lot dimensions
- permit application date
- building type/classification
- whether project includes houseplex, coach house, secondary suite, lock-off, or rental redevelopment

## Site Plan / Zoning

Flag if missing or unreadable:

- property lines and lot dimensions
- north arrow
- legal address / civic address
- setbacks from all property lines
- building footprint, lot coverage, FAR/density table where applicable
- parking count and driveway dimensions
- proposed and existing grades
- tree retention/removal notes
- storm/sanitary/water service notes
- DCC or servicing notes where development type suggests applicability

Use Surrey Zoning Bylaw 12000 for zone-specific permitted use, setbacks, height, density, lot coverage, parking, and accessory/coach/secondary-suite conditions.

## Floor Plans

Flag if floor-plan-like sheets have no extracted:

- room labels
- room dimensions
- door/window tags
- stairs/landings
- smoke/CO alarms
- suite separation notes where multiple dwelling units are present
- mechanical/electrical/service room labels

Do not expect room labels on pure elevation sheets, section sheets, schedules, or detail sheets.

## Elevations

Flag if elevation-like sheets have no extracted:

- average grade / datum
- main floor, top floor, roof plate, roof ridge levels
- building height
- exterior materials
- window/door openings
- spatial separation / exposing building face data where relevant

Do not flag missing rooms on elevations.

## Sections

Flag if section/detail sheets have no extracted:

- ceiling heights
- floor-to-floor heights
- foundation/slab notes
- roof/floor/wall assemblies
- insulation / vapour barrier / rainscreen notes
- fire separation and party wall assemblies
- stair/headroom/guard/handrail notes where stairs are shown

## BCBC 2024 Common Precheck Topics

For Part 9 residential/small-building style projects, screen for:

- egress and exits
- bedroom emergency egress windows where applicable
- smoke alarms and carbon monoxide alarms
- stairs, guards, handrails, landings
- fire separations between dwelling units, suites, garages, and common spaces
- spatial separation / limiting distance / exposed building face
- radon rough-in
- ventilation
- cooling requirement
- energy requirements
- earthquake/seismic notes depending on permit date and in-stream status
- registered professional involvement when complexity suggests it

## False Positive Control

Before creating an issue, infer sheet type from:

- sheet id
- title
- source pages
- extracted `floor_levels`, `units`, `site_data`, `structural_notes`

Examples:

- `A104 ELEVATIONS` should be checked for heights, floor levels, materials, openings, not rooms.
- `A106 SECTION` should be checked for assemblies/heights/foundation, not room counts.
- `UNKNOWN` sheets should usually be `warning` or `blocker` for identification/readability.

## Output Tone

Write as a plan-review intake assistant:

- concise
- evidence-based
- no legal finality
- clear action for designer/contractor
- cite official source category and URL when available
