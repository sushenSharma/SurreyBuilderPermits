---
name: surrey-plan-precheck
description: Use when reviewing City of Surrey, BC permit plan PDFs or extracted sheet JSON for zoning, bylaw, BC Building Code 2024, and city-review completeness risks before submission. This skill guides prechecks for Surrey residential and small-building projects, including zoning setbacks, height, parking, site plan data, tree/site servicing flags, and BCBC Part 9 drawing completeness.
---

# Surrey Plan Precheck

Use this skill for City of Surrey plan-layout prechecks. It is a review workflow, not a legal/code-book copy.

Do not treat this skill as the authority. Always verify against current official sources before making a final compliance statement, because bylaws and provincial code provisions change.

## Source Rules

- Use official City of Surrey and Province of B.C. sources first.
- Do not reproduce full BC Building Code books or full bylaw books in generated output. Summarize, cite, and link.
- Treat Surrey consolidated bylaws as convenience copies. For legal certainty, flag that certified versions or original amendment bylaws may be required.
- If the project address, zone, lot dimensions, or permit date are missing, classify zoning/code conclusions as `needs_clarification`.
- For BC Building Code, identify whether the permit is under BCBC 2024 and whether Part 9 or Part 3 review is likely. Do not make a professional-engineering conclusion.

## References

Read `references/official-sources.md` when you need source links.

Read `references/precheck-rules.md` when turning extracted JSON into issues.

## Workflow

1. Identify project context:
   - civic address
   - legal lot dimensions and lot area
   - zoning category from COSMOS or plan notes
   - building type: single-family, houseplex, coach house, secondary suite, townhouse, Part 9 small building, or Part 3 building
   - permit application date

2. Check drawing completeness:
   - site plan with north arrow, property lines, setbacks, driveway, parking, services, grades, trees, lot coverage/FAR tables
   - floor plans with room labels, dimensions, stairs, doors/windows, smoke/CO alarms, suite separations
   - elevations with grade references, roof ridge, building height, exterior materials, exposed building face data where relevant
   - sections with ceiling heights, floor-to-floor heights, foundation depth, insulation, fire separations, assemblies
   - schedules/details for doors, windows, guards, stairs, energy, radon, fireblocking, and structural notes

3. Check Surrey bylaw/zoning risks:
   - zone and permitted use
   - setbacks/yards
   - height
   - lot coverage / density / FAR where applicable
   - off-street parking and driveway dimensions
   - secondary suite / coach house / houseplex conditions
   - trees, boulevard, servicing, drainage, erosion/sediment control, DCC applicability

4. Check BCBC drawing risks:
   - egress, exits, stairs, guards, handrails
   - smoke alarms / CO alarms
   - bedroom windows / emergency egress where applicable
   - fire separations, spatial separations, limiting distance/exposing building face
   - radon rough-in, ventilation, cooling requirement, energy performance
   - foundation, structure, lateral/seismic notes, registered professional requirements

5. Output issues in this JSON-compatible shape:

```json
{
  "severity": "blocker | warning | info | needs_clarification",
  "sheet_id": "A101",
  "source": "Surrey Zoning Bylaw 12000 | BCBC 2024 | Surrey Building Construction Regulation Bylaw 17850",
  "category": "zoning | building-code | drawing-completeness | site-servicing | tree | parking",
  "issue": "Plain-language concern a reviewer would understand.",
  "evidence": "Extracted value or missing field from the plan JSON.",
  "recommended_action": "What to verify or revise before submission.",
  "official_source_url": "https://..."
}
```

## Severity Guidance

- `blocker`: likely to prevent meaningful review or commonly triggers a resubmission, such as no site plan, no room dimensions on a floor plan, unknown zone, missing setbacks, unreadable building height, or no section data.
- `warning`: likely review comment or incomplete coordination, such as low extraction confidence, missing door/window tags, incomplete parking data, unclear floor levels.
- `info`: manual spot-check item, low-confidence OCR note, or source-verification reminder.
- `needs_clarification`: required project context is missing, such as zone, address, permit date, lot area, or building classification.

## Important Limits

This skill helps with pre-submission screening. It does not replace a Surrey plan checker, registered professional, code consultant, lawyer, or certified bylaw copy.
