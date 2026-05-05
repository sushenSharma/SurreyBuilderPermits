---
name: bcbc-dimensions
description: >
  Use when checking extracted A-sheet room records, ceiling heights, hallway widths,
  door tags, and window tags against BCBC 2024 residential Section 9.5.
  Run after room, door, and window extraction completes. Produces PASS / FAIL /
  VERIFY / N/A style compliance findings for extracted rooms and openings.
---

# BCBC 2024 — A-Sheet Compliance Skill
# Source: British Columbia Building Codes 2024, Division B
# Scope: Residential occupancy, A-sheets only (rooms, doors, windows, stairs)
# Last updated from: Section 9.5 (provided verbatim by user)

---

## HOW TO USE THIS SKILL

This skill contains **exact rule thresholds** extracted from BCBC 2024 verbatim.
Do NOT hallucinate values. Every number here has a section reference.
When running checks, always cite the section (e.g. "BCBC 9.5.3.1 Table 9.5.3.1").

Input you will receive:
- Room records: { type, width_ft, depth_ft, height_ft, unit }
- Door records: { tag, width_in, height_in, location }
- Window records: { tag, width_in, height_in, room }

Output you must produce:
- Per room: PASS / FAIL / N/A per check with exact measured vs required values
- Per door: PASS / FAIL with exact measured vs required
- Building level: unit completeness checks

Project app status mapping:
- PASS = compliant with the loaded threshold.
- FLAG = not compliant / below the loaded threshold.
- VERIFY = extracted data is missing, ambiguous, physically unlikely, or requires another sheet/crop.
- N/A = rule does not apply to that room/opening.

---

## 9.5.1 — MEASUREMENT METHOD

**9.5.1.1 — How to measure:**
- Dimensions measured between **finished wall surfaces**
- Heights measured between **finished floor and ceiling surfaces**
- ⚠️ All extracted dimensions from drawings are assumed to be finished dimensions unless noted otherwise

**9.5.1.2 — Combination Rooms:**
- Two areas may be treated as one room IF the opening between them is the **larger of:**
  - 3.0 m², OR
  - 40% of the wall area (measured on the dependent side)
- If dependent area is a bedroom → direct passage required between the two areas

---

## 9.5.3 — CEILING HEIGHTS

**9.5.3.1 — Minimum ceiling heights (Table 9.5.3.1)**

All measurements in **metres**. Convert ft → m: multiply by 0.3048.

| Room / Space | Min Ceiling Height (m) | Min Clear Height (m) | Min Area This Height Must Cover |
|---|---|---|---|
| Living room or space | 2.1 | — | Lesser of room area or 10.0 m² |
| Dining room or space | 2.1 | — | Lesser of room area or 5.2 m² |
| Kitchen or kitchen space | 2.1 | — | Lesser of room area or 3.2 m² |
| Master bedroom / bedroom space | 2.1 | — | Lesser of room area or 4.9 m² |
| Other bedroom / sleeping space | 2.1 | 2.0 | Lesser of room area or 3.5 m² |
| Unfinished basement incl. laundry | — | 1.95 (under beams / passage) | Area of the space |
| Bathroom / WC / laundry (above grade) | 2.1 | — | Lesser of room area or 2.2 m² |
| Passage / hall / main entrance vestibule | 2.1 | — | Area of the space |
| Habitable rooms not mentioned above | 2.1 | — | Lesser of room area or 2.2 m² |

**Rule 9.5.3.1(4):** Areas meeting the minimum ceiling height must be **contiguous with the entry/entries** to those rooms.

**9.5.3.3 — Storage Garages:**
- Min clear height: **2.0 m**

---

## 9.5.4 — HALLWAYS

**9.5.4.1 — Hallway width within dwelling unit:**
- Standard minimum unobstructed width: **860 mm (2'-10")**
- Permitted reduction to **710 mm (2'-4")** only if BOTH:
  - a) Only bedrooms and bathrooms at the far end of the hallway, AND
  - b) A second exit is provided in the hallway near that far end, OR in each bedroom served

---

## 9.5.5 — DOORWAY SIZES

**9.5.5.1 — Door sizes (Table 9.5.5.1)**

All measurements in **mm**. Convert inches → mm: multiply by 25.4.

| Door Location | Min Width (mm) | Min Height (mm) |
|---|---|---|
| Dwelling unit required entrance | 810 | 1,980 |
| Vestibule or entrance hall | 810 | 1,980 |
| Stairs to floor level with finished space | 810 | 1,980 |
| All doors in one line of passage exterior → basement | 810 | 1,980 |
| Utility rooms | 610 | 1,980 |
| Walk-in closet | 610 | 1,980 |
| Bathroom / WC / shower room | 610 | 1,980 |
| Rooms off 710mm-wide hallways | 610 | 760 |
| Rooms not mentioned above / exterior balconies | 610 | 1,980 |

**9.5.5.2 — Public water-closet rooms:**
- Min width: **810 mm**, min height: **2,030 mm**

**9.5.5.3 — Doorways to rooms with bathtub / shower / WC:**
- Applies when hallway ≥ 860 mm wide serves those rooms
- At least ONE doorway in that hallway must:
  - Provide access to at least 1 of each fixture type
  - Accommodate a door **not less than 760 mm wide**

---

## DOOR TAG DECODER

Standard door tag format used in BC drawings: **WHXX**
- First 2 digits = width in inches × 12 (e.g. 30 = 2'6", 36 = 3'0")
- Last 2 digits = height in inches × 12 (e.g. 68 = 6'8", 80 = 8'0")

| Tag | Width | Height | Width (mm) | Height (mm) |
|---|---|---|---|---|
| 2068 | 2'0" | 6'8" | 610 | 2,032 |
| 2468 | 2'4" | 6'8" | 711 | 2,032 |
| 2668 | 2'6" | 6'8" | 762 | 2,032 |
| 2868 | 2'8" | 6'8" | 813 | 2,032 |
| 3068 | 3'0" | 6'8" | 914 | 2,032 |
| 3268 | 3'2" | 6'8" | 965 | 2,032 |

⚠️ Note: 6'8" = 2,032 mm which exceeds the 1,980 mm minimum. All standard 6'8" doors pass height check.

---

## CHECK LOGIC — ROOMS

### Step 1: Convert dimensions
```
width_m  = width_ft  × 0.3048
depth_m  = depth_ft  × 0.3048
height_m = height_ft × 0.3048
area_m2  = width_m × depth_m
min_dim  = min(width_m, depth_m)
```

### Step 2: Apply ceiling height check (9.5.3.1)
Look up room type in Table 9.5.3.1 above.
- Check: height_m ≥ min_ceiling_height
- Check: area_m2 ≥ min_area_over_which_height_applies
  (if room area < table value, the full room area must meet the height)

### Step 3: Room-type specific checks
Currently covered sections:
- ✅ 9.5.3.1 — ceiling heights
- ✅ 9.5.4.1 — hallway widths
- ✅ 9.5.5.1 — door sizes
- 🔲 9.5.6   — egress windows (add when section provided)
- 🔲 9.5.2   — accessible design (add when section provided)
- 🔲 9.8     — stairs (add when section provided)

---

## CHECK LOGIC — DOORS

```
For each door record:
  width_mm  = door_width_in × 25.4
  height_mm = door_height_in × 25.4

  Look up door location → get min_width, min_height from Table 9.5.5.1
  PASS if width_mm  ≥ min_width
  PASS if height_mm ≥ min_height
```

### Location mapping from drawing context:
| Drawing label | Table 9.5.5.1 category |
|---|---|
| Entry / front door | Dwelling unit required entrance → 810 × 1,980 |
| Bathroom door | Bathroom/WC/shower → 610 × 1,980 |
| Closet door | Walk-in closet → 610 × 1,980 |
| Utility / boiler room | Utility room → 610 × 1,980 |
| Bedroom door | Rooms not mentioned → 610 × 1,980 |
| Hallway door | Check hallway width first → 9.5.5.3 |

---

## UNIT COMPLETENESS CHECKS

Per dwelling unit, verify presence of:
- [ ] At least 1 bedroom (or sleeping space)
- [ ] At least 1 bathroom (3pc minimum: WC + basin + bath/shower)
- [ ] Kitchen or kitchen space
- [ ] Living/family room or combined living-dining

These are inferred from room records grouped by unit.

---

## OUTPUT FORMAT

For each check produce:
```json
{
  "room": "Bedroom — Unit A",
  "check": "Min ceiling height",
  "required": "2.1 m",
  "measured": "2.44 m",
  "result": "PASS",
  "ref": "BCBC 9.5.3.1 Table 9.5.3.1"
}
```

For failures, also produce:
```json
{
  "correction": "Ceiling height of 1.95m is below the 2.1m minimum for bedrooms. Increase ceiling height or reclassify space."
}
```

---

## SECTIONS NOT YET LOADED

The following sections are referenced but not yet added to this skill.
Do not run these checks until the actual code text is provided:

| Section | Topic | Status |
|---|---|---|
| 9.5.6 | Egress windows | 🔲 Not loaded |
| 9.5.2 | Accessible design detail | 🔲 Not loaded |
| 9.8 | Stairs — rise, run, handrail | 🔲 Not loaded |
| 9.36.2 | Fenestration / energy | 🔲 Not loaded |
| 9.10 | Fire separations | 🔲 Not loaded (needs S-sheets) |
