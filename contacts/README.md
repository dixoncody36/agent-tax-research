# Contacts

Research contacts and interview records for the initial discovery phase of the agentic tax research platform.

This directory is the human-input side of the project: who knows what, what they told us, and what we still need to learn before agents start collecting tax rates and rules at scale.

## Layout

| Path | What goes there |
|---|---|
| `contacts/*.md` | One file per contact (person or organization). |
| `contacts/interviews/*.md` | One file per interview, call, or research session. |
| `contacts/_template-contact.md` | Copy this to add a new contact. |
| `contacts/_template-interview.md` | Copy this to record a new interview. |

## Adding a contact

1. Copy `_template-contact.md` to `contacts/<first>-<last>.md` (organizations: `contacts/org-<slug>.md`).
2. Fill in the front matter and sections. Keep it factual: role, jurisdictions and tax topics they cover, how to reach them, and what they are a good source for.
3. Link related interviews from the contact file, and link back to the contact from each interview file.

## Adding an interview

1. Copy `_template-interview.md` to `contacts/interviews/YYYY-MM-DD-<contact-slug>-<short-topic>.md`.
2. Record the date, participants, purpose, key findings, jurisdiction / tax-type details, sources cited, and follow-ups.
3. Separate what was said from our interpretation. Mark unverified claims as unverified — an agent or researcher must confirm them against a primary source before they become platform data.

## What to capture

Initial research needs, per jurisdiction and tax type where known:

- Authoritative sources (statute, regulation, tax authority guidance, gazette, official rate tables) and where they are published.
- How rates and rules change: cadence, effective-date conventions, advance notice, and where changes are announced.
- Filing, registration, and threshold rules that affect who a rate or rule applies to.
- Known gaps, ambiguities, and traps (informal practice vs. written law, language / translation issues, subnational variation).
- Existing data providers, feeds, or publications worth evaluating — and their limits.

## Handling

- Do not commit passwords, API keys, or other secrets here.
- Keep personal data to what the research needs (name, role, organization, professional contact details, and interview content the contact agreed to have recorded).
- If a contact asks for something to stay off the record, omit it or mark the file accordingly and do not quote it elsewhere.
- Interview notes are research input, not tax advice and not verified platform data.
